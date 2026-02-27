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
  Feature,
  CrawlPlan,
  RouteInfo,
  ScreenType,
} from "@docuagent/shared";
import {
  MAX_SCREENS_DEFAULT,
  PAGE_TIMEOUT_MS,
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
  features: Feature[];
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
  featureId: string | null;
  featureSlug: string | null;
  screenshotLabel: string; // e.g., "hero", "invite-form-filled"
  createdEntityId: string | null;
  status: "crawled";
  orderIndex: number;
}

export interface CrawlError {
  featureId: string;
  action: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Duplicate detection — URL-based + DOM-hash
// ---------------------------------------------------------------------------

const domHashes = new Set<string>();
const capturedUrls = new Set<string>();

function hashDom(dom: string): string {
  return crypto.createHash("md5").update(dom).digest("hex");
}

function isDuplicate(dom: string): boolean {
  const hash = hashDom(dom);
  if (domHashes.has(hash)) return true;
  domHashes.add(hash);
  return false;
}

function isUrlAlreadyCaptured(url: string): boolean {
  try {
    const normalized = new URL(url).pathname;
    return capturedUrls.has(normalized);
  } catch {
    return capturedUrls.has(url);
  }
}

function markUrlCaptured(url: string): void {
  try {
    capturedUrls.add(new URL(url).pathname);
  } catch {
    capturedUrls.add(url);
  }
}

// ---------------------------------------------------------------------------
// Auth page detection
// ---------------------------------------------------------------------------

const AUTH_PAGE_PATTERNS = [
  "/login", "/sign-in", "/signin", "/sign-up", "/signup",
  "/register", "/auth", "/account/login",
];

function isAuthPageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return AUTH_PAGE_PATTERNS.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// Chrome-error and Cloudflare detection
// ---------------------------------------------------------------------------

function isChromeErrorPage(url: string): boolean {
  return url.startsWith("chrome-error://");
}

async function isCloudflareBlock(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.evaluate(() => {
      return (globalThis as any).document?.body?.innerText?.substring(0, 2000) ?? "";
    });
    const lower = bodyText.toLowerCase();
    return (
      lower.includes("cloudflare") &&
      (lower.includes("blocked") ||
        lower.includes("attention required") ||
        lower.includes("security service") ||
        lower.includes("ray id"))
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Page health check
// ---------------------------------------------------------------------------

async function checkPageHealth(page: Page): Promise<string | null> {
  const url = page.url();
  if (isChromeErrorPage(url)) return "browser error page";
  if (await isCloudflareBlock(page)) return "Cloudflare security block";
  return null;
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
// Auto-detect login page (2A)
// ---------------------------------------------------------------------------

export async function findLoginPage(
  stagehand: Stagehand,
  page: Page,
  appUrl: string,
  hasCredentials: boolean,
): Promise<string | null> {
  console.log("[crawl] Auto-detecting login page...");

  // 1. Visit app URL — check if it already has login fields
  try {
    await page.goto(appUrl, { waitUntil: "networkidle", timeoutMs: PAGE_TIMEOUT_MS });
    await waitForSettle(page);
  } catch {
    // timeout OK, continue checking
  }

  const currentUrl = page.url();

  // Check if we were redirected to a login page
  if (isAuthPageUrl(currentUrl)) {
    console.log(`[crawl] App URL redirected to login: ${currentUrl}`);
    return currentUrl;
  }

  // Check if current page has login fields
  const hasLoginForm = await page.evaluate(() => {
    const d = (globalThis as any).document;
    const inputs = d.querySelectorAll('input[type="email"], input[type="password"], input[name="email"], input[name="password"]');
    return inputs.length >= 2;
  });
  if (hasLoginForm) {
    console.log(`[crawl] App URL itself is the login page: ${currentUrl}`);
    return currentUrl;
  }

  // 2. Try common login paths
  const commonPaths = ["/login", "/sign-in", "/signin", "/auth/login", "/auth", "/account/login"];
  const baseUrl = appUrl.replace(/\/$/, "");

  for (const path of commonPaths) {
    try {
      const testUrl = `${baseUrl}${path}`;
      await page.goto(testUrl, { waitUntil: "networkidle", timeoutMs: 10_000 });
      const hasForm = await page.evaluate(() => {
        const d = (globalThis as any).document;
        const inputs = d.querySelectorAll('input[type="email"], input[type="password"], input[name="email"], input[name="password"]');
        return inputs.length >= 1;
      });
      if (hasForm) {
        console.log(`[crawl] Found login page at: ${testUrl}`);
        return testUrl;
      }
    } catch {
      // path not reachable, try next
    }
  }

  // 3. Look for login links on the page
  try {
    await page.goto(appUrl, { waitUntil: "networkidle", timeoutMs: PAGE_TIMEOUT_MS });
    const loginLink = await page.evaluate(() => {
      const d = (globalThis as any).document;
      const links = Array.from(d.querySelectorAll("a")) as any[];
      const found = links.find((a: any) => {
        const text = (a.innerText ?? "").toLowerCase();
        return text.includes("sign in") || text.includes("log in") || text.includes("login");
      });
      return found?.href ?? null;
    });
    if (loginLink) {
      console.log(`[crawl] Found login link: ${loginLink}`);
      return loginLink;
    }
  } catch {
    // failed, continue
  }

  if (hasCredentials) {
    console.error("[crawl] Could not find login page. Credentials provided but no login page found.");
    return null;
  }

  console.log("[crawl] No login page found, proceeding without authentication");
  return null;
}

// ---------------------------------------------------------------------------
// Detect app name from page (CHANGE 5 — fixed extraction)
// ---------------------------------------------------------------------------

export async function detectAppName(
  stagehand: Stagehand,
  page: Page,
  productDescription?: string | null,
): Promise<string> {
  let appName = "";

  // 1. Try Stagehand observe for brand/logo
  try {
    const observations = await stagehand.observe(
      "Find the application or company name/logo in the header or navigation bar. Return the text of the brand name.",
      { timeout: 10_000 },
    );
    if (observations.length > 0) {
      let raw = observations[0].description?.trim() ?? "";

      // CHANGE 5: Extract just the name from Stagehand's description
      // If the response contains quoted text like 'ACME' or "ACME", extract it
      const quotedMatch = raw.match(/['"]([^'"]+)['"]/);
      if (quotedMatch) {
        raw = quotedMatch[1];
      }

      // If result is longer than 30 chars, it's a description not a name
      if (raw.length <= 30) {
        appName = raw;
      }
    }
  } catch {
    // observe failed, try fallback
  }

  // 2. If still empty or generic, try product description first
  const genericNames = ["home", "dashboard", "next.js", "app", ""];
  if (genericNames.includes(appName.toLowerCase()) && productDescription) {
    const match = productDescription.match(/^([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)*)/);
    if (match) {
      appName = match[1];
    }
  }

  // 3. If still generic, try document.title
  if (genericNames.includes(appName.toLowerCase())) {
    try {
      const title = await page.evaluate(() => {
        return (globalThis as any).document?.title ?? "";
      });
      // Clean up title: remove " - Dashboard", " | Home" etc.
      appName = title
        .replace(/\s*[-|–—]\s*(dashboard|home|admin|app|settings|next\.js).*$/i, "")
        .trim();
    } catch {
      // fallback below
    }
  }

  // 4. Remove common suffixes
  appName = appName
    .replace(/\s*[-|–—]\s*(Dashboard|Home|Admin|App|Settings|Next\.js)$/i, "")
    .trim();

  // 5. Final fallback — URL hostname
  if (!appName || genericNames.includes(appName.toLowerCase())) {
    try {
      const hostname = new URL(page.url()).hostname;
      appName = hostname.replace(/^www\./, "").split(".")[0];
      appName = appName.charAt(0).toUpperCase() + appName.slice(1);
    } catch {
      appName = "Application";
    }
  }

  console.log(`[crawl] Detected app name: "${appName}"`);
  return appName;
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
      // DB columns still named journey_id/journey_step for backward compat
      journey_id: record.featureId,
      journey_step: record.featureSlug ? 0 : null,
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

      await waitForSettle(page);
      await page.waitForTimeout(3000);

      const currentUrl = page.url();
      console.log(`[crawl] Post-login URL: ${currentUrl}`);

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
  if (loginUrl && url.startsWith(loginUrl)) return true;
  return isAuthPageUrl(url);
}

async function hasActualLoginForm(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const d = (globalThis as any).document;
      const passwordInputs = d.querySelectorAll('input[type="password"]');
      const hasNavOrSidebar = d.querySelectorAll("nav, aside, .sidebar, [role='navigation']").length > 0;
      if (passwordInputs.length === 0) return false;
      const bodyText = (d.body as any)?.innerText ?? "";
      const hasDashboardContent = bodyText.length > 2000 && hasNavOrSidebar;
      return !hasDashboardContent;
    });
  } catch {
    return false;
  }
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
    featureId: string | null;
    featureSlug: string | null;
    screenshotLabel: string; // e.g., "hero", "invite-form-filled"
    navPath: string | null;
    screenType: ScreenType;
    codeContext: Record<string, unknown> | null;
    orderIndex: number;
    broadcastLabel: string;
    descriptiveFilename: string; // e.g., "team-management.png"
    skipDuplicateCheck?: boolean; // for action screenshots on same page
  },
): Promise<{ record: ScreenRecord; screenshotUrl: string | null } | null> {
  const url = page.url();

  // Check page health first
  const healthIssue = await checkPageHealth(page);
  if (healthIssue) {
    console.log(`[crawl] Skipped: ${healthIssue} at ${url}`);
    return null;
  }

  // Check URL-based duplicate (skip for action screenshots on same page)
  if (!opts.skipDuplicateCheck && isUrlAlreadyCaptured(url)) {
    console.log(`[crawl] Skipping already-captured URL: ${url}`);
    return null;
  }

  const dom = await cleanDom(page);

  // Skip DOM duplicate check for action screenshots (same page, different state)
  if (!opts.skipDuplicateCheck && isDuplicate(dom)) {
    console.log(`[crawl] Skipping duplicate DOM at ${url}`);
    return null;
  }

  // Mark URL as captured (only for hero screenshots)
  if (!opts.skipDuplicateCheck) {
    markUrlCaptured(url);
  }

  const screenshotBuffer = await takeScreenshot(page);
  const filename = opts.descriptiveFilename;
  let screenshotUrl = await uploadScreenshot(jobId, screenshotBuffer, filename);

  // Retry upload once if it failed
  if (!screenshotUrl) {
    console.log(`[crawl] Retrying screenshot upload after 3s delay...`);
    await page.waitForTimeout(3000);
    screenshotUrl = await uploadScreenshot(jobId, screenshotBuffer, filename);
  }

  const record: ScreenRecord = {
    id: "",
    url,
    routePath: new URL(url).pathname,
    navPath: opts.navPath,
    screenshotUrl,
    domHtml: dom,
    codeContext: opts.codeContext,
    screenType: opts.screenType,
    featureId: opts.featureId,
    featureSlug: opts.featureSlug,
    screenshotLabel: opts.screenshotLabel,
    createdEntityId: null,
    status: "crawled",
    orderIndex: opts.orderIndex,
  };

  const id = await storeScreen(jobId, record);
  record.id = id;

  await broadcastProgress(
    jobId,
    "screenshot",
    `Captured: ${opts.broadcastLabel}`,
    screenshotUrl ?? undefined,
  );

  return { record, screenshotUrl };
}

// ---------------------------------------------------------------------------
// Fill form fields with sample data (no submit)
// ---------------------------------------------------------------------------

async function fillFormFields(
  stagehand: Stagehand,
  page: Page,
  featureName: string,
): Promise<boolean> {
  try {
    // Check if the page has visible form fields
    const hasFields = await page.evaluate(() => {
      const d = (globalThis as any).document;
      const inputs = d.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], textarea, select'
      );
      // Filter to only visible inputs
      return Array.from(inputs).some((el: any) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !el.disabled;
      });
    });

    if (!hasFields) {
      console.log(`[crawl] No form fields found on ${featureName}`);
      return false;
    }

    console.log(`[crawl] Filling form fields on ${featureName}...`);

    // Use Stagehand to fill fields with realistic sample data
    await stagehand.act(
      `Fill in all visible form fields with realistic sample data. For name fields use "Jane Smith". For email fields use "jane@acme.com". For phone fields use "555-0123". For URL fields use "https://example.com". For text areas, type a brief realistic sentence. Select any visible radio buttons or checkboxes. Do NOT click any submit, save, or delete buttons.`,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(500);

    return true;
  } catch (err) {
    console.error(`[crawl] Form fill failed on ${featureName}:`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main crawl engine — FEATURE-BASED
// ---------------------------------------------------------------------------

export async function runCrawl(config: CrawlConfig): Promise<CrawlResult> {
  const startTime = Date.now();
  const maxScreens = config.maxScreens ?? MAX_SCREENS_DEFAULT;
  const screens: ScreenRecord[] = [];
  const errors: CrawlError[] = [];
  let orderIndex = 0;
  let reAuthCount = 0;
  const MAX_REAUTHS = 2;

  // Reset duplicate detection
  domHashes.clear();
  capturedUrls.clear();

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
          featureId: "auth",
          action: "login",
          error: "Authentication failed after 2 attempts",
        });
        await broadcastProgress(config.jobId, "error", "Login failed");
        return { screens, errors, totalDurationMs: Date.now() - startTime };
      }
      await broadcastProgress(config.jobId, "info", "Login successful!");
    } else if (!config.loginUrl && config.credentials) {
      const detectedLogin = await findLoginPage(stagehand, page, config.appUrl, true);
      if (detectedLogin) {
        await broadcastProgress(config.jobId, "info", `Auto-detected login page: ${detectedLogin}`);
        const loggedIn = await authenticate(stagehand, page, detectedLogin, config.credentials);
        if (!loggedIn) {
          errors.push({ featureId: "auth", action: "login", error: "Auto-detected login failed" });
          await broadcastProgress(config.jobId, "error", "Login failed — could not find login page. Please provide the login URL.");
          return { screens, errors, totalDurationMs: Date.now() - startTime };
        }
        await broadcastProgress(config.jobId, "info", "Login successful!");
      } else {
        await broadcastProgress(config.jobId, "error", "Could not find login page. Please provide the login URL.");
        errors.push({ featureId: "auth", action: "find-login", error: "Could not find login page" });
        return { screens, errors, totalDurationMs: Date.now() - startTime };
      }
    } else {
      // No login required — just navigate to app URL
      await page.goto(config.appUrl, {
        waitUntil: "networkidle",
        timeoutMs: PAGE_TIMEOUT_MS,
      });
      await waitForSettle(page);
    }

    // ----- Feature crawl -----
    const { features } = config;

    if (!features || features.length === 0) {
      console.log("[crawl] No features to crawl");
      return { screens, errors, totalDurationMs: Date.now() - startTime };
    }

    console.log(`\n[crawl] === Feature Crawl: ${features.length} features ===`);

    for (let fi = 0; fi < features.length; fi++) {
      const feature = features[fi];

      if (screens.length >= maxScreens) {
        console.log(`[crawl] Max screens (${maxScreens}) reached, stopping`);
        await broadcastProgress(config.jobId, "info", `Max screens reached, stopping crawl`);
        break;
      }

      console.log(`\n[crawl] --- Documenting: ${feature.name} (${fi + 1}/${features.length}) ---`);
      await broadcastProgress(
        config.jobId,
        "info",
        `Documenting: ${feature.name} (${fi + 1}/${features.length})`,
      );

      await updateJobProgress(config.jobId, {
        screens_found: screens.length,
        screens_crawled: screens.length,
        current_step: `${feature.name} (${fi + 1}/${features.length})`,
      });

      try {
        // Navigate to the feature's page
        const fullUrl = feature.route.startsWith("http")
          ? feature.route
          : `${config.appUrl.replace(/\/$/, "")}${feature.route}`;

        try {
          await page.goto(fullUrl, {
            waitUntil: "networkidle",
            timeoutMs: PAGE_TIMEOUT_MS,
          });
        } catch {
          // Timeout OK, try clicking the sidebar link instead
          console.log(`[crawl] Direct navigation timeout, trying sidebar click for ${feature.name}`);
          try {
            await stagehand.act(
              `Click the sidebar or navigation link labeled "${feature.name}"`,
              { timeout: 15_000 },
            );
          } catch {
            console.log(`[crawl] Sidebar click also failed for ${feature.name}`);
          }
        }
        await waitForSettle(page);

        // Check page health
        const healthIssue = await checkPageHealth(page);
        if (healthIssue) {
          console.log(`[crawl] Skipped ${feature.name}: ${healthIssue}`);
          await broadcastProgress(config.jobId, "info", `Skipped ${feature.name}: ${healthIssue}`);
          continue;
        }

        // Check for session expiry
        const currentUrl = page.url();
        if (isRedirectedToLogin(currentUrl, config.loginUrl)) {
          const hasLoginFields = await hasActualLoginForm(page);
          if (hasLoginFields && reAuthCount < MAX_REAUTHS && config.loginUrl && config.credentials) {
            reAuthCount++;
            console.log(`[crawl] Session expired, re-authenticating (${reAuthCount}/${MAX_REAUTHS})...`);
            await broadcastProgress(config.jobId, "info", `Session expired, re-authenticating...`);
            const reauthed = await authenticate(stagehand, page, config.loginUrl, config.credentials);
            if (!reauthed) {
              errors.push({ featureId: feature.id, action: "re-auth", error: "Re-authentication failed" });
              continue;
            }
            // Retry navigation
            await page.goto(fullUrl, { waitUntil: "networkidle", timeoutMs: PAGE_TIMEOUT_MS });
            await waitForSettle(page);
          } else if (hasLoginFields) {
            errors.push({ featureId: feature.id, action: "navigate", error: "Session expired, re-auth cap reached" });
            continue;
          }
        }

        // Find code context for this route
        const routeInfo = config.crawlPlan.routes.find(
          (r) => feature.route && r.path === feature.route,
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

        // --- HERO screenshot: default state of the page ---
        await broadcastProgress(config.jobId, "info", `Capturing ${feature.name} — default view`);
        const heroResult = await captureScreen(page, config.jobId, {
          featureId: feature.id,
          featureSlug: feature.slug,
          screenshotLabel: "hero",
          navPath: feature.name,
          screenType: "page",
          codeContext,
          orderIndex,
          broadcastLabel: `${feature.name} — default view`,
          descriptiveFilename: `${feature.slug}.png`,
        });
        if (heroResult) {
          screens.push(heroResult.record);
          orderIndex++;
        }

        // --- ACTION screenshot: fill forms with sample data ---
        if (feature.hasForm && screens.length < maxScreens) {
          await broadcastProgress(config.jobId, "info", `Capturing ${feature.name} — filling form`);
          const filled = await fillFormFields(stagehand, page, feature.name);
          if (filled) {
            const actionResult = await captureScreen(page, config.jobId, {
              featureId: feature.id,
              featureSlug: feature.slug,
              screenshotLabel: "form-filled",
              navPath: `${feature.name} (form filled)`,
              screenType: "page",
              codeContext,
              orderIndex,
              broadcastLabel: `${feature.name} — form filled`,
              descriptiveFilename: `${feature.slug}-filled.png`,
              skipDuplicateCheck: true,
            });
            if (actionResult) {
              screens.push(actionResult.record);
              orderIndex++;
            }
          }
        }

        console.log(`[crawl] Feature "${feature.name}" complete`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[crawl] Feature "${feature.name}" failed: ${errMsg}`);
        errors.push({
          featureId: feature.id,
          action: `crawl ${feature.name}`,
          error: errMsg,
        });
        await broadcastProgress(config.jobId, "error", `Failed to document ${feature.name}: ${errMsg}`);
      }
    }

    // ----- Final summary -----
    const totalDurationMs = Date.now() - startTime;
    console.log(`\n[crawl] === Crawl Complete ===`);
    console.log(`[crawl] Screens captured: ${screens.length}`);
    console.log(`[crawl] Errors: ${errors.length}`);
    console.log(`[crawl] Re-authentications: ${reAuthCount}`);
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
