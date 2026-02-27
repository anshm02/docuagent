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
// Smart page exploration helpers
// ---------------------------------------------------------------------------

async function hasPageChanged(page: Page, referenceBuffer: Buffer): Promise<boolean> {
  const current = await takeScreenshot(page);
  if (Math.abs(referenceBuffer.length - current.length) < 500) {
    const refSlice = referenceBuffer.slice(0, 1000).toString("hex");
    const curSlice = current.slice(0, 1000).toString("hex");
    if (refSlice === curSlice) return false;
  }
  return true;
}

interface DetectedField {
  type: string;
  label: string;
  name: string;
  placeholder: string;
}

async function detectFormFields(page: Page): Promise<DetectedField[]> {
  return page.evaluate(() => {
    const d = (globalThis as any).document;
    const fields: any[] = [];
    const inputs = d.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select',
    );
    for (const el of Array.from(inputs) as any[]) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || el.disabled) continue;
      let label = "";
      if (el.id) {
        const labelEl = d.querySelector(`label[for="${el.id}"]`);
        if (labelEl) label = (labelEl.textContent ?? "").trim();
      }
      if (!label) {
        const cl = el.closest("label");
        if (cl) label = (cl.textContent ?? "").trim();
      }
      if (!label) label = el.placeholder || el.name || el.getAttribute("aria-label") || "";
      fields.push({
        type:
          el.tagName === "TEXTAREA"
            ? "textarea"
            : el.tagName === "SELECT"
              ? "select"
              : el.type ?? "text",
        label: label.substring(0, 50),
        name: el.name ?? "",
        placeholder: el.placeholder ?? "",
      });
    }
    return fields;
  });
}

function getSampleValue(
  field: DetectedField,
): { instruction: string } | null {
  const label = field.label || field.name || field.placeholder;
  if (!label) return null;
  const lower = label.toLowerCase();
  const type = field.type.toLowerCase();

  if (type === "checkbox")
    return { instruction: `Check the "${label}" checkbox` };
  if (type === "radio")
    return { instruction: `Select the first "${label}" radio option` };
  if (type === "select" || type === "select-one")
    return {
      instruction: `Click the "${label}" dropdown and select the second option`,
    };
  // Skip password fields
  if (type === "password") return null;

  if (type === "email" || lower.includes("email")) {
    return {
      instruction: `Type 'sarah@company.com' into the ${label} field`,
    };
  }
  if (lower.includes("phone") || lower.includes("tel") || type === "tel") {
    return {
      instruction: `Type '+1 (555) 123-4567' into the ${label} field`,
    };
  }
  if (
    lower.includes("name") ||
    lower.includes("first") ||
    lower.includes("last") ||
    lower.includes("display")
  ) {
    return {
      instruction: `Type 'Sarah Johnson' into the ${label} field`,
    };
  }
  if (lower.includes("url") || lower.includes("website") || type === "url") {
    return {
      instruction: `Type 'https://example.com' into the ${label} field`,
    };
  }
  if (type === "number") {
    return { instruction: `Type '42' into the ${label} field` };
  }
  if (type === "date" || lower.includes("date")) {
    return {
      instruction: `Click the ${label} date picker and select tomorrow's date`,
    };
  }
  if (type === "textarea") {
    return {
      instruction: `Type 'Review quarterly objectives and key results for Q4.' into the ${label} field`,
    };
  }
  // Default text
  return {
    instruction: `Type 'Sample text for testing' into the ${label} field`,
  };
}

const UNSAFE_BUTTON_WORDS = [
  "delete",
  "remove",
  "send",
  "invite",
  "share",
  "pay",
  "cancel",
  "deactivate",
  "reset",
];

interface ExplorationResult {
  screens: ScreenRecord[];
  interactionsCompleted: number;
}

async function smartExploreFeature(
  stagehand: Stagehand,
  page: Page,
  feature: Feature,
  jobId: string,
  codeContext: Record<string, unknown> | null,
  heroBuffer: Buffer,
  startOrderIndex: number,
  maxActionScreenshots: number,
): Promise<ExplorationResult> {
  const screens: ScreenRecord[] = [];
  let orderIndex = startOrderIndex;
  let actionCount = 0;
  let lastBuffer = heroBuffer;
  const startTime = Date.now();
  const TIME_BUDGET_MS = 60_000;
  const MAX_ACTIONS = Math.min(maxActionScreenshots, 4);

  const isTimedOut = () => Date.now() - startTime > TIME_BUDGET_MS;
  const canDoMore = () => actionCount < MAX_ACTIONS && !isTimedOut();

  // Helper: capture action screenshot if page changed
  async function captureAction(
    label: string,
    filename: string,
    broadcastLabel: string,
    screenType: ScreenType = "page",
  ): Promise<boolean> {
    if (!canDoMore()) return false;
    if (!(await hasPageChanged(page, lastBuffer))) {
      console.log(
        `[crawl] No visual change after ${label}, skipping screenshot`,
      );
      return false;
    }
    const result = await captureScreen(page, jobId, {
      featureId: feature.id,
      featureSlug: feature.slug,
      screenshotLabel: label,
      navPath: `${feature.name} (${label})`,
      screenType,
      codeContext,
      orderIndex,
      broadcastLabel: `${feature.name} — ${broadcastLabel}`,
      descriptiveFilename: filename,
      skipDuplicateCheck: true,
    });
    if (result) {
      screens.push(result.record);
      orderIndex++;
      actionCount++;
      lastBuffer = await takeScreenshot(page);
      return true;
    }
    return false;
  }

  // ---- Priority 1: Form fields ----
  const fields = await detectFormFields(page);
  if (fields.length > 0 && canDoMore()) {
    console.log(
      `[crawl] Found ${fields.length} form fields on ${feature.name}, filling...`,
    );
    let filledCount = 0;
    const maxFields = 6; // Limit to stay within time budget
    for (const field of fields.slice(0, maxFields)) {
      if (isTimedOut()) break;
      const sample = getSampleValue(field);
      if (!sample) continue;
      try {
        await stagehand.act(sample.instruction, { timeout: 10_000 });
        filledCount++;
        await page.waitForTimeout(300);
      } catch {
        // field fill failed, continue to next
      }
    }
    if (filledCount > 0) {
      console.log(
        `[crawl] Filled ${filledCount}/${fields.length} fields on ${feature.name}`,
      );
      await page.waitForTimeout(500);
      await captureAction(
        "form-filled",
        `${feature.slug}-form-filled.png`,
        "form filled",
      );

      // ---- Part D: Try safe submit ----
      if (canDoMore()) {
        try {
          const submitButtons = await stagehand.observe(
            `Find any submit/save/create button on this page. Only report buttons labeled: Save, Save Changes, Update, Create, Add, Apply, Confirm, Submit. Do NOT report buttons labeled: Delete, Remove, Send, Invite, Share, Pay, Cancel Account, Deactivate, Reset. For each button, tell me its exact label text.`,
            { timeout: 10_000 },
          );
          if (submitButtons.length > 0) {
            const btnLabel =
              submitButtons[0].description?.trim() ?? "Submit";
            const lower = btnLabel.toLowerCase();
            const isUnsafe = UNSAFE_BUTTON_WORDS.some((u) =>
              lower.includes(u),
            );
            if (!isUnsafe) {
              console.log(
                `[crawl] Clicking safe submit: "${btnLabel}"`,
              );
              await stagehand.act(
                `Click the "${btnLabel}" button`,
                { timeout: 10_000 },
              );
              await waitForSettle(page);
              await page.waitForTimeout(2000);
              await captureAction(
                "result",
                `${feature.slug}-result.png`,
                "after submit",
              );
            }
          }
        } catch {
          // submit detection failed, continue
        }
      }
    }
  }

  // ---- Priority 2: Modal triggers, tabs, accordions ----
  if (canDoMore()) {
    try {
      const elements = await stagehand.observe(
        `List interactive elements in the MAIN CONTENT AREA that would reveal new content when clicked. Look for: buttons labeled "Add", "Create", "New", "Edit" (these open modals/dialogs); tab buttons; accordion headers; toggle sections. Ignore sidebar, header nav, form fields, submit buttons. For each element, report its type (modal_trigger, tab, accordion) and label text.`,
        { timeout: 15_000 },
      );

      for (const el of elements) {
        if (!canDoMore()) break;
        const desc = (el.description ?? "").toLowerCase();
        const label = el.description?.trim() ?? "";

        // Modal triggers
        if (
          desc.includes("modal") ||
          desc.includes("dialog") ||
          desc.includes("add") ||
          desc.includes("create") ||
          desc.includes("new") ||
          (desc.includes("edit") && !desc.includes("tab"))
        ) {
          if (UNSAFE_BUTTON_WORDS.some((u) => desc.includes(u))) continue;

          try {
            console.log(
              `[crawl] Opening modal: "${label}" on ${feature.name}`,
            );
            await stagehand.act(`Click the "${label}" button`, {
              timeout: 10_000,
            });
            await waitForSettle(page);
            await page.waitForTimeout(1000);

            const captured = await captureAction(
              "modal-open",
              `${feature.slug}-modal-open.png`,
              "modal opened",
              "modal",
            );

            // Close modal
            if (captured) {
              try {
                await stagehand.act(
                  "Close this dialog or modal by clicking the X button or close button",
                  { timeout: 5_000 },
                );
              } catch {
                try {
                  await stagehand.act(
                    "Press the Escape key to close the modal",
                    { timeout: 5_000 },
                  );
                } catch {
                  /* ignore */
                }
              }
              await page.waitForTimeout(500);
              lastBuffer = await takeScreenshot(page);
            }
          } catch {
            continue;
          }
        }
        // Tabs
        else if (desc.includes("tab")) {
          try {
            const tabSlug = label
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .substring(0, 20);
            console.log(
              `[crawl] Clicking tab: "${label}" on ${feature.name}`,
            );
            await stagehand.act(`Click the "${label}" tab`, {
              timeout: 10_000,
            });
            await waitForSettle(page);
            await captureAction(
              `tab-${tabSlug}`,
              `${feature.slug}-tab-${tabSlug}.png`,
              `tab: ${label}`,
              "tab",
            );
          } catch {
            continue;
          }
        }
        // Accordions / collapsibles
        else if (
          desc.includes("accordion") ||
          desc.includes("expand") ||
          desc.includes("collapse") ||
          desc.includes("collapsible")
        ) {
          try {
            console.log(
              `[crawl] Expanding: "${label}" on ${feature.name}`,
            );
            await stagehand.act(`Click to expand "${label}"`, {
              timeout: 10_000,
            });
            await waitForSettle(page);
            await captureAction(
              "expanded",
              `${feature.slug}-expanded.png`,
              "expanded section",
            );
          } catch {
            continue;
          }
        }
      }
    } catch {
      // observe failed, continue
    }
  }

  // ---- Scroll check for below-fold content ----
  if (canDoMore()) {
    try {
      const dims = await page.evaluate(() => ({
        scrollHeight: (globalThis as any).document.documentElement
          .scrollHeight,
        viewportHeight: (globalThis as any).window.innerHeight,
      }));
      if (dims.scrollHeight > dims.viewportHeight * 1.5) {
        console.log(
          `[crawl] Below-fold content detected (${dims.scrollHeight}px), scrolling...`,
        );
        await page.evaluate(() =>
          (globalThis as any).window.scrollTo(
            0,
            (globalThis as any).document.documentElement.scrollHeight / 2,
          ),
        );
        await waitForSettle(page);
        await captureAction(
          "scrolled",
          `${feature.slug}-scrolled.png`,
          "below-fold content",
        );
        // Scroll back to top
        await page.evaluate(() =>
          (globalThis as any).window.scrollTo(0, 0),
        );
      }
    } catch {
      /* ignore scroll errors */
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[crawl] Feature "${feature.name}" exploration: ${actionCount} action screenshots in ${elapsed}s`,
  );

  return { screens, interactionsCompleted: actionCount };
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

        // --- SMART EXPLORATION: observe + interact + screenshot changes ---
        if (screens.length < maxScreens) {
          const heroBuffer = await takeScreenshot(page);
          await broadcastProgress(config.jobId, "info", `Exploring ${feature.name}...`);
          const exploration = await smartExploreFeature(
            stagehand,
            page,
            feature,
            config.jobId,
            codeContext,
            heroBuffer,
            orderIndex,
            maxScreens - screens.length,
          );
          screens.push(...exploration.screens);
          orderIndex += exploration.screens.length;
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
