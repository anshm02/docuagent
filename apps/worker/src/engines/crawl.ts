import { Stagehand, Page } from "@browserbasehq/stagehand";
import { getSupabase } from "../lib/supabase.js";
import {
  initStagehand,
  closeStagehand,
  takeScreenshot,
  waitForSettle,
  cleanDom,
} from "../lib/stagehand.js";
import type {
  Journey,
  JourneyStep,
  CrawlPlan,
  RouteInfo,
  Screen,
  ScreenType,
} from "@docuagent/shared";
import {
  MAX_SCREENS_DEFAULT,
  SCREENSHOT_WIDTH,
  SCREENSHOT_HEIGHT,
  PAGE_TIMEOUT_MS,
  MODAL_DELAY_MS,
} from "@docuagent/shared";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrawlConfig {
  jobId: string;
  appUrl: string;
  loginUrl?: string;
  credentials?: { username: string; password: string };
  journeys: Journey[];
  crawlPlan: CrawlPlan;
  maxScreens?: number;
}

export interface CrawlResult {
  screens: ScreenRecord[];
  errors: CrawlError[];
  totalDurationMs: number;
}

export interface ScreenRecord {
  id: string;
  url: string;
  routePath: string | null;
  navPath: string | null;
  screenshotUrl: string | null;
  domHtml: string | null;
  codeContext: Record<string, unknown> | null;
  screenType: ScreenType;
  journeyId: string | null;
  journeyStep: number | null;
  createdEntityId: string | null;
  status: "crawled";
  orderIndex: number;
}

export interface CrawlError {
  journeyId: string;
  stepIndex: number;
  action: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

const domHashes = new Set<string>();

function hashDom(dom: string): string {
  return crypto.createHash("md5").update(dom).digest("hex");
}

function isDuplicate(dom: string): boolean {
  const hash = hashDom(dom);
  if (domHashes.has(hash)) return true;
  domHashes.add(hash);
  return false;
}

// ---------------------------------------------------------------------------
// Screenshot upload
// ---------------------------------------------------------------------------

async function uploadScreenshot(
  jobId: string,
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  try {
    const supabase = getSupabase();
    const path = `screenshots/${jobId}/${filename}`;
    const { error } = await supabase.storage
      .from("screenshots")
      .upload(path, buffer, {
        contentType: "image/png",
        upsert: true,
      });
    if (error) {
      console.error(`[crawl] Upload failed for ${filename}:`, error.message);
      return null;
    }
    const { data } = supabase.storage.from("screenshots").getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.error(`[crawl] Upload exception for ${filename}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Store screen record
// ---------------------------------------------------------------------------

async function storeScreen(
  jobId: string,
  record: ScreenRecord,
): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("screens")
    .insert({
      job_id: jobId,
      url: record.url,
      route_path: record.routePath,
      nav_path: record.navPath,
      screenshot_url: record.screenshotUrl,
      dom_html: record.domHtml,
      code_context: record.codeContext,
      screen_type: record.screenType,
      journey_id: record.journeyId,
      journey_step: record.journeyStep,
      created_entity_id: record.createdEntityId,
      status: "crawled",
      order_index: record.orderIndex,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[crawl] Failed to store screen:", error.message);
    throw error;
  }
  return data.id;
}

// ---------------------------------------------------------------------------
// Progress broadcasting
// ---------------------------------------------------------------------------

async function broadcastProgress(
  jobId: string,
  type: "info" | "screenshot" | "error",
  message: string,
  screenshotUrl?: string,
): Promise<void> {
  try {
    const supabase = getSupabase();
    await supabase.from("progress_messages").insert({
      job_id: jobId,
      type,
      message,
      screenshot_url: screenshotUrl ?? null,
    });
  } catch {
    // non-critical
  }
}

async function updateJobProgress(
  jobId: string,
  progress: Record<string, unknown>,
): Promise<void> {
  try {
    const supabase = getSupabase();
    await supabase
      .from("jobs")
      .update({ progress })
      .eq("id", jobId);
  } catch {
    // non-critical
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function authenticate(
  stagehand: Stagehand,
  page: Page,
  loginUrl: string,
  credentials: { username: string; password: string },
): Promise<boolean> {
  console.log(`[crawl] Navigating to login page: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "networkidle", timeoutMs: PAGE_TIMEOUT_MS });
  await waitForSettle(page);

  const priorUrl = page.url();

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.log("[crawl] Retrying login...");
      await page.goto(loginUrl, { waitUntil: "networkidle", timeoutMs: PAGE_TIMEOUT_MS });
      await waitForSettle(page);
    }

    try {
      await stagehand.act(
        `Type "${credentials.username}" into the email or username input field`,
        { timeout: 15_000 },
      );
      await stagehand.act(
        `Type "${credentials.password}" into the password input field`,
        { timeout: 15_000 },
      );
      await stagehand.act("Click the sign in, log in, or submit button", {
        timeout: 15_000,
      });

      // Wait for navigation after login
      await waitForSettle(page);
      await page.waitForTimeout(3000);

      const currentUrl = page.url();
      console.log(`[crawl] Post-login URL: ${currentUrl}`);

      // Check if we navigated away from login page
      const loginPatterns = ["/login", "/sign-in", "/signin", "/sign-up", "/signup", "/auth"];
      const stillOnLogin = loginPatterns.some((p) => currentUrl.toLowerCase().includes(p));

      if (!stillOnLogin || currentUrl !== priorUrl) {
        console.log("[crawl] Login succeeded!");
        return true;
      }
    } catch (err) {
      console.error(`[crawl] Login attempt ${attempt + 1} failed:`, err);
    }
  }

  console.error("[crawl] Login failed after 2 attempts");
  return false;
}

// ---------------------------------------------------------------------------
// Session expiry detection
// ---------------------------------------------------------------------------

function isRedirectedToLogin(url: string, loginUrl?: string): boolean {
  const loginPatterns = ["/login", "/sign-in", "/signin", "/sign-up", "/signup", "/auth"];
  const lower = url.toLowerCase();
  if (loginUrl && url.startsWith(loginUrl)) return true;
  return loginPatterns.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// Nav discovery fallback
// ---------------------------------------------------------------------------

export async function discoverNavigation(
  stagehand: Stagehand,
  page: Page,
): Promise<RouteInfo[]> {
  console.log("[crawl] Discovering navigation via Stagehand observe...");
  try {
    const actions = await stagehand.observe(
      "Find all navigation links in the sidebar, top navigation bar, header, and any dropdown menus. Return each link with its text and URL.",
    );

    const routes: RouteInfo[] = [];
    const seen = new Set<string>();

    for (const action of actions) {
      const desc = action.description ?? "";
      // Try to extract URL from the selector or description
      const hrefMatch = desc.match(/href=["']([^"']+)["']/);
      const path = hrefMatch?.[1] ?? `/${desc.toLowerCase().replace(/\s+/g, "-")}`;

      if (seen.has(path)) continue;
      seen.add(path);

      routes.push({
        path,
        component: desc,
        type: "other",
        fields: [],
        modals: [],
        permissions: [],
        apiCalls: [],
      });
    }

    console.log(`[crawl] Discovered ${routes.length} navigation links`);
    return routes;
  } catch (err) {
    console.error("[crawl] Nav discovery failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Capture a single screen
// ---------------------------------------------------------------------------

async function captureScreen(
  page: Page,
  jobId: string,
  opts: {
    journeyId: string | null;
    journeyStep: number | null;
    navPath: string | null;
    screenType: ScreenType;
    codeContext: Record<string, unknown> | null;
    orderIndex: number;
    label: string;
  },
): Promise<{ record: ScreenRecord; screenshotUrl: string | null } | null> {
  const url = page.url();
  const dom = await cleanDom(page);

  if (isDuplicate(dom)) {
    console.log(`[crawl] Skipping duplicate screen at ${url}`);
    return null;
  }

  const screenshotBuffer = await takeScreenshot(page);
  const filename = `screen_${opts.orderIndex}_${Date.now()}.png`;
  const screenshotUrl = await uploadScreenshot(jobId, screenshotBuffer, filename);

  const record: ScreenRecord = {
    id: "",
    url,
    routePath: new URL(url).pathname,
    navPath: opts.navPath,
    screenshotUrl,
    domHtml: dom,
    codeContext: opts.codeContext,
    screenType: opts.screenType,
    journeyId: opts.journeyId,
    journeyStep: opts.journeyStep,
    createdEntityId: null,
    status: "crawled",
    orderIndex: opts.orderIndex,
  };

  const id = await storeScreen(jobId, record);
  record.id = id;

  await broadcastProgress(
    jobId,
    "screenshot",
    `Captured: ${opts.label} (${url})`,
    screenshotUrl ?? undefined,
  );

  return { record, screenshotUrl };
}

// ---------------------------------------------------------------------------
// Journey execution
// ---------------------------------------------------------------------------

async function executeStep(
  stagehand: Stagehand,
  page: Page,
  step: JourneyStep,
  journeyTitle: string,
  appUrl: string,
): Promise<void> {
  // Navigate to the target route
  if (step.target_route && step.target_route !== "use_navigation") {
    const fullUrl = step.target_route.startsWith("http")
      ? step.target_route
      : `${appUrl.replace(/\/$/, "")}${step.target_route}`;

    try {
      await page.goto(fullUrl, {
        waitUntil: "networkidle",
        timeoutMs: PAGE_TIMEOUT_MS,
      });
    } catch {
      console.log(`[crawl] Direct navigation timeout for ${fullUrl}, trying stagehand act`);
      await stagehand.act(step.action, { timeout: PAGE_TIMEOUT_MS });
    }
  } else {
    // Use stagehand to navigate
    await stagehand.act(step.action, { timeout: PAGE_TIMEOUT_MS });
  }

  await waitForSettle(page);
}

async function handleInteraction(
  stagehand: Stagehand,
  page: Page,
  step: JourneyStep,
): Promise<string | null> {
  if (!step.interaction) return null;

  let createdEntityId: string | null = null;

  try {
    await stagehand.act(step.interaction, { timeout: PAGE_TIMEOUT_MS });
    await waitForSettle(page);

    // If this step creates data, try to extract the entity ID
    if (step.creates_data) {
      try {
        const currentUrl = page.url();
        // Try to extract ID from URL (e.g., /projects/123)
        const idMatch = currentUrl.match(/\/([a-f0-9-]+|[0-9]+)(?:[/?#]|$)/);
        if (idMatch) {
          createdEntityId = idMatch[1];
        }
      } catch {
        // non-critical
      }
    }
  } catch (err) {
    console.error(`[crawl] Interaction failed: ${step.interaction}`, err);
  }

  return createdEntityId;
}

// ---------------------------------------------------------------------------
// Modal handling
// ---------------------------------------------------------------------------

async function handleModals(
  stagehand: Stagehand,
  page: Page,
  captures: string[],
  jobId: string,
  journeyId: string,
  orderIndex: number,
): Promise<{ records: ScreenRecord[]; nextOrderIndex: number }> {
  const records: ScreenRecord[] = [];
  let idx = orderIndex;

  const modalCaptures = captures.filter((c) => c.startsWith("modal:"));
  for (const capture of modalCaptures) {
    const modalName = capture.replace("modal:", "");
    try {
      console.log(`[crawl] Opening modal: ${modalName}`);
      await stagehand.act(`Click the button or link that opens the ${modalName} modal or dialog`, {
        timeout: 15_000,
      });
      await page.waitForTimeout(MODAL_DELAY_MS);

      const result = await captureScreen(page, jobId, {
        journeyId,
        journeyStep: idx,
        navPath: `Modal: ${modalName}`,
        screenType: "modal",
        codeContext: null,
        orderIndex: idx,
        label: `Modal: ${modalName}`,
      });
      if (result) {
        records.push(result.record);
        idx++;
      }

      // Close the modal
      try {
        await stagehand.act("Close the modal or dialog by clicking the close button or X", {
          timeout: 10_000,
        });
        await page.waitForTimeout(500);
      } catch {
        // Try escape key
        await page.keyPress("Escape");
        await page.waitForTimeout(500);
      }
    } catch (err) {
      console.error(`[crawl] Modal "${modalName}" failed:`, err);
    }
  }

  return { records, nextOrderIndex: idx };
}

// ---------------------------------------------------------------------------
// Tab handling
// ---------------------------------------------------------------------------

async function handleTabs(
  stagehand: Stagehand,
  page: Page,
  jobId: string,
  journeyId: string,
  orderIndex: number,
): Promise<{ records: ScreenRecord[]; nextOrderIndex: number }> {
  const records: ScreenRecord[] = [];
  let idx = orderIndex;

  try {
    const tabs = await stagehand.observe(
      "Find all tab elements (role=tab or elements styled as tabs) on the page",
    );

    if (tabs.length > 1) {
      console.log(`[crawl] Found ${tabs.length} tabs, clicking each...`);
      for (let i = 1; i < tabs.length && i < 6; i++) {
        try {
          const tab = tabs[i];
          await stagehand.act(`Click the tab labeled "${tab.description}"`, {
            timeout: 10_000,
          });
          await page.waitForTimeout(800);

          const result = await captureScreen(page, jobId, {
            journeyId,
            journeyStep: idx,
            navPath: `Tab: ${tab.description}`,
            screenType: "tab",
            codeContext: null,
            orderIndex: idx,
            label: `Tab: ${tab.description}`,
          });
          if (result) {
            records.push(result.record);
            idx++;
          }
        } catch (err) {
          console.error(`[crawl] Tab click failed:`, err);
        }
      }
    }
  } catch {
    // No tabs found — ok
  }

  return { records, nextOrderIndex: idx };
}

// ---------------------------------------------------------------------------
// Dropdown handling
// ---------------------------------------------------------------------------

async function handleDropdowns(
  stagehand: Stagehand,
  page: Page,
  jobId: string,
  journeyId: string,
  orderIndex: number,
): Promise<{ records: ScreenRecord[]; nextOrderIndex: number }> {
  const records: ScreenRecord[] = [];
  let idx = orderIndex;

  try {
    const dropdowns = await stagehand.observe(
      "Find all dropdown or select elements on the page that can be expanded",
    );

    if (dropdowns.length > 0) {
      // Only expand first 3 dropdowns to avoid noise
      for (let i = 0; i < Math.min(dropdowns.length, 3); i++) {
        try {
          await stagehand.act(`Click the dropdown "${dropdowns[i].description}" to expand it`, {
            timeout: 10_000,
          });
          await page.waitForTimeout(500);

          const result = await captureScreen(page, jobId, {
            journeyId,
            journeyStep: idx,
            navPath: `Dropdown: ${dropdowns[i].description}`,
            screenType: "page",
            codeContext: null,
            orderIndex: idx,
            label: `Dropdown: ${dropdowns[i].description}`,
          });
          if (result) {
            records.push(result.record);
            idx++;
          }

          // Close dropdown
          await page.keyPress("Escape");
          await page.waitForTimeout(300);
        } catch {
          // Skip failed dropdowns
        }
      }
    }
  } catch {
    // No dropdowns found — ok
  }

  return { records, nextOrderIndex: idx };
}

// ---------------------------------------------------------------------------
// Main crawl engine
// ---------------------------------------------------------------------------

export async function runCrawl(config: CrawlConfig): Promise<CrawlResult> {
  const startTime = Date.now();
  const maxScreens = config.maxScreens ?? MAX_SCREENS_DEFAULT;
  const screens: ScreenRecord[] = [];
  const errors: CrawlError[] = [];
  let orderIndex = 0;

  // Reset duplicate detection
  domHashes.clear();

  console.log("[crawl] Initializing Stagehand...");
  const { stagehand, page } = await initStagehand();

  try {
    // ----- Authentication -----
    if (config.loginUrl && config.credentials) {
      await broadcastProgress(config.jobId, "info", "Logging in...");
      const loggedIn = await authenticate(
        stagehand,
        page,
        config.loginUrl,
        config.credentials,
      );
      if (!loggedIn) {
        errors.push({
          journeyId: "auth",
          stepIndex: 0,
          action: "login",
          error: "Authentication failed after 2 attempts",
        });
        await broadcastProgress(config.jobId, "error", "Login failed");
        return { screens, errors, totalDurationMs: Date.now() - startTime };
      }
      await broadcastProgress(config.jobId, "info", "Login successful!");
    } else {
      // No login required — just navigate to app URL
      await page.goto(config.appUrl, {
        waitUntil: "networkidle",
        timeoutMs: PAGE_TIMEOUT_MS,
      });
      await waitForSettle(page);
    }

    // ----- Nav discovery fallback -----
    let journeys = config.journeys;
    if (!journeys || journeys.length === 0) {
      console.log("[crawl] No journeys provided, using nav discovery fallback");
      const discoveredRoutes = await discoverNavigation(stagehand, page);

      // Create a simple journey from discovered routes
      journeys = [{
        id: "discovery",
        title: "Application Navigation",
        description: "Auto-discovered navigation paths",
        priority: 1,
        steps: discoveredRoutes.map((route) => ({
          action: `Navigate to ${route.path}`,
          target_route: route.path,
          captures: ["page"],
        })),
      }];
    }

    // ----- Journey execution -----
    const sortedJourneys = [...journeys].sort((a, b) => a.priority - b.priority);

    for (const journey of sortedJourneys) {
      if (screens.length >= maxScreens) {
        console.log(`[crawl] Max screens (${maxScreens}) reached, stopping`);
        await broadcastProgress(config.jobId, "info", `Max screens (${maxScreens}) reached, stopping crawl`);
        break;
      }

      console.log(`\n[crawl] === Journey: ${journey.title} (priority ${journey.priority}) ===`);
      await broadcastProgress(
        config.jobId,
        "info",
        `Starting journey: ${journey.title} (${journey.steps.length} steps)`,
      );

      let stepsSucceeded = 0;

      for (let stepIdx = 0; stepIdx < journey.steps.length; stepIdx++) {
        if (screens.length >= maxScreens) break;

        const step = journey.steps[stepIdx];
        const stepLabel = `Journey "${journey.title}" — Step ${stepIdx + 1}/${journey.steps.length}: ${step.action}`;
        console.log(`[crawl] ${stepLabel}`);
        await broadcastProgress(config.jobId, "info", stepLabel);

        await updateJobProgress(config.jobId, {
          screens_found: screens.length,
          screens_crawled: screens.length,
          current_step: `${journey.title} - Step ${stepIdx + 1}/${journey.steps.length}`,
        });

        try {
          // Execute the navigation/action
          await executeStep(stagehand, page, step, journey.title, config.appUrl);

          // Check for session expiry
          if (isRedirectedToLogin(page.url(), config.loginUrl)) {
            console.log("[crawl] Session expired, re-authenticating...");
            await broadcastProgress(config.jobId, "info", "Session expired, re-authenticating...");
            if (config.loginUrl && config.credentials) {
              const reauthed = await authenticate(
                stagehand,
                page,
                config.loginUrl,
                config.credentials,
              );
              if (!reauthed) {
                const failMsg = `Step ${stepIdx + 1} failed: Re-authentication failed. Continuing.`;
                console.error(`[crawl] ${failMsg}`);
                await broadcastProgress(config.jobId, "error", failMsg);
                errors.push({
                  journeyId: journey.id,
                  stepIndex: stepIdx,
                  action: step.action,
                  error: "Re-authentication failed",
                });
                continue;
              }
              // Retry step after re-auth
              await executeStep(stagehand, page, step, journey.title, config.appUrl);
            }
          }

          // Find code context for this route
          const routeInfo = config.crawlPlan.routes.find(
            (r) => step.target_route && r.path === step.target_route,
          );
          const codeContext = routeInfo
            ? {
                component: routeInfo.component,
                fields: routeInfo.fields,
                modals: routeInfo.modals,
                permissions: routeInfo.permissions,
                apiCalls: routeInfo.apiCalls,
              }
            : null;

          // Capture main screen
          if (step.captures?.includes("page") || !step.captures || step.captures.length === 0) {
            const result = await captureScreen(page, config.jobId, {
              journeyId: journey.id,
              journeyStep: stepIdx,
              navPath: step.action,
              screenType: "page",
              codeContext,
              orderIndex,
              label: step.action,
            });
            if (result) {
              screens.push(result.record);
              orderIndex++;
            }
          }

          // Handle interaction (form fill, button click, etc.)
          if (step.interaction && screens.length < maxScreens) {
            // Screenshot before interaction
            if (step.creates_data) {
              const beforeResult = await captureScreen(page, config.jobId, {
                journeyId: journey.id,
                journeyStep: stepIdx,
                navPath: `${step.action} - before submit`,
                screenType: "page",
                codeContext,
                orderIndex,
                label: `${step.action} - pre-submit`,
              });
              if (beforeResult) {
                screens.push(beforeResult.record);
                orderIndex++;
              }
            }

            const entityId = await handleInteraction(stagehand, page, step);

            // Screenshot after interaction
            if (screens.length < maxScreens) {
              const afterResult = await captureScreen(page, config.jobId, {
                journeyId: journey.id,
                journeyStep: stepIdx,
                navPath: `${step.action} - after`,
                screenType: "page",
                codeContext,
                orderIndex,
                label: `${step.action} - post-action`,
              });
              if (afterResult) {
                if (entityId) {
                  afterResult.record.createdEntityId = entityId;
                }
                screens.push(afterResult.record);
                orderIndex++;
              }
            }
          }

          // Handle modals
          if (step.captures && screens.length < maxScreens) {
            const modalResult = await handleModals(
              stagehand,
              page,
              step.captures,
              config.jobId,
              journey.id,
              orderIndex,
            );
            screens.push(...modalResult.records);
            orderIndex = modalResult.nextOrderIndex;
          }

          stepsSucceeded++;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const failMsg = `Step ${stepIdx + 1} failed: ${errMsg}. Continuing.`;
          console.error(`[crawl] ${failMsg}`);
          errors.push({
            journeyId: journey.id,
            stepIndex: stepIdx,
            action: step.action,
            error: errMsg,
          });
          await broadcastProgress(config.jobId, "error", failMsg);
        }
      }

      // Journey completion summary
      const journeyEndMsg = `Journey "${journey.title}" complete: ${stepsSucceeded}/${journey.steps.length} steps succeeded`;
      console.log(`[crawl] ${journeyEndMsg}`);
      await broadcastProgress(config.jobId, "info", journeyEndMsg);
    }

    // ----- Final summary -----
    const totalDurationMs = Date.now() - startTime;
    console.log(`\n[crawl] === Crawl Complete ===`);
    console.log(`[crawl] Screens captured: ${screens.length}`);
    console.log(`[crawl] Errors: ${errors.length}`);
    console.log(`[crawl] Duration: ${(totalDurationMs / 1000).toFixed(1)}s`);

    await broadcastProgress(
      config.jobId,
      "info",
      `Crawl complete: ${screens.length} screens captured in ${(totalDurationMs / 1000).toFixed(1)}s`,
    );

    return { screens, errors, totalDurationMs };
  } finally {
    await closeStagehand();
  }
}
