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
import { claudeVision, claudeVisionMulti, parseJsonResponse } from "../lib/claude.js";
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
  appUnderstanding?: AppUnderstanding;
}

// ---------------------------------------------------------------------------
// Two-phase exploration types
// ---------------------------------------------------------------------------

export interface PageUnderstanding {
  page_purpose: string;
  user_goals: string[];
  interactive_elements: InteractiveElement[];
  empty_state: boolean;
  empty_state_cta?: string;
  connected_features: string[];
  page_complexity: "simple" | "moderate" | "complex";
}

interface InteractiveElement {
  what: string;
  type:
    | "form_field"
    | "dropdown"
    | "button"
    | "tab"
    | "chart_element"
    | "table_filter"
    | "modal_trigger"
    | "accordion"
    | "toggle"
    | "date_picker"
    | "color_picker"
    | "search_as_feature"
    | "navigation_search";
  explore_action: string;
}

interface ScreenshotPlan {
  description: string;
  actions: string[];
  value: string;
  submit_after: boolean;
  capture_result: boolean;
}

export interface FeatureUnderstanding {
  name: string;
  slug: string;
  purpose: string;
  userGoals: string[];
  connectedFeatures: string[];
  screenshotDescriptions: string[];
}

export interface AppUnderstanding {
  appName: string;
  features: FeatureUnderstanding[];
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
// Overlay dismissal — clear popups before screenshots
// ---------------------------------------------------------------------------

async function dismissOverlays(page: Page, stagehand: Stagehand): Promise<void> {
  try {
    const hasOverlay = await page.evaluate(() => {
      const d = (globalThis as any).document;
      const selectors = [
        '[class*="cookie"]', '[class*="consent"]', '[class*="popup"]',
        '[class*="modal"][class*="overlay"]', '[class*="banner"]',
        '[class*="notification"]', '[class*="toast"]',
        '[role="dialog"]', '[class*="onboarding"]',
      ];
      for (const sel of selectors) {
        const el = d.querySelector(sel);
        if (el && el.offsetHeight > 0) return true;
      }
      return false;
    });

    if (hasOverlay) {
      await stagehand.act(
        "Close any popup, banner, cookie notice, or overlay that is blocking the main content. Click the X button, Close button, Accept button, or Dismiss button.",
        { timeout: 5000 },
      ).catch(async () => {
        try {
          await stagehand.act("Press the Escape key", { timeout: 3000 });
        } catch { /* ignore */ }
      });
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {
    // Overlays are best-effort
  }
}

// ---------------------------------------------------------------------------
// Loading state detection — wait for spinners/skeletons to finish
// ---------------------------------------------------------------------------

async function waitForContentLoaded(page: Page): Promise<void> {
  await waitForSettle(page);

  const hasLoader = await page.evaluate(() => {
    const d = (globalThis as any).document;
    const loaderSelectors = [
      '[class*="loading"]', '[class*="spinner"]', '[class*="skeleton"]',
      '[class*="placeholder"]', '[role="progressbar"]',
      '.animate-pulse', '.animate-spin',
    ];
    for (const sel of loaderSelectors) {
      const el = d.querySelector(sel);
      if (el && el.offsetHeight > 0) return true;
    }
    return false;
  });

  if (hasLoader) {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const stillLoading = await page.evaluate(() => {
        const d = (globalThis as any).document;
        const el = d.querySelector(
          '[class*="loading"], [class*="spinner"], [class*="skeleton"], .animate-pulse, .animate-spin',
        );
        return el && el.offsetHeight > 0;
      });
      if (!stillLoading) break;
    }
  }
}

// ---------------------------------------------------------------------------
// Screenshot comparison — content area only (Claude vision)
// ---------------------------------------------------------------------------

let comparisonCallsThisFeature = 0;

async function hasPageMeaningfullyChanged(
  before: Buffer,
  after: Buffer,
): Promise<boolean> {
  // Quick size check — very different sizes = definitely changed
  if (Math.abs(before.length - after.length) > 5000) return true;

  // Rate limit: max 2 comparison calls per feature
  if (comparisonCallsThisFeature >= 2) {
    // Fall back to byte comparison
    const refSlice = before.slice(0, 2000).toString("hex");
    const curSlice = after.slice(0, 2000).toString("hex");
    return refSlice !== curSlice;
  }

  // 3-second delay before each comparison call (rate limit protection)
  await new Promise((r) => setTimeout(r, 3000));
  comparisonCallsThisFeature++;

  try {
    const response = await claudeVisionMulti(
      `Compare these two screenshots. Look ONLY at the MAIN CONTENT AREA — ignore the header, search bar, sidebar, and navigation completely.

Is the main content meaningfully different between the two screenshots?
Answer with just: {"changed": true} or {"changed": false}`,
      [
        { mediaType: "image/png", data: before.toString("base64") },
        { mediaType: "image/png", data: after.toString("base64") },
      ],
      { maxTokens: 50, system: "You compare screenshots." },
    );

    const result = JSON.parse(response);
    return result.changed === true;
  } catch {
    // If parsing/API fails, assume changed to be safe
    return true;
  }
}

// ---------------------------------------------------------------------------
// Phase 1: EXPLORE — Understand the page with Claude vision
// ---------------------------------------------------------------------------

async function explorePage(
  stagehand: Stagehand,
  page: Page,
  feature: Feature,
  heroBase64: string,
  fullUrl: string,
): Promise<PageUnderstanding> {
  console.log(`[crawl] Phase 1: Exploring "${feature.name}"...`);

  const explorationPrompt = `Look at this screenshot of the "${feature.name}" page carefully.

Tell me:

1. PAGE_PURPOSE: What is this page for? What real-world user need does it serve? (1-2 sentences)

2. USER_GOALS: What would a user come to this page to accomplish? List 1-4 concrete goals.
   Examples: "Add a new team member", "Check which projects are overdue", "Create a calendar event"

3. INTERACTIVE_ELEMENTS: What can I click, fill, hover, expand, or interact with in the MAIN CONTENT AREA?
   For each element:
   - what: describe it ("Email input field in the Invite section", "Status filter dropdown above the table", "Add Event button")
   - type: form_field | dropdown | button | tab | chart_element | table_filter | modal_trigger | accordion | toggle | date_picker | color_picker | search_as_feature | navigation_search
   - explore_action: what should I do to understand it? ("Click to see dropdown options", "Hover to see tooltip data", "Click to open creation modal")

   CRITICAL DISTINCTIONS:
   - A search bar in the page HEADER or TOP NAVIGATION BAR = "navigation_search" (it searches across the whole app, not this page's content)
   - A search/filter bar WITHIN the main content area that filters THIS PAGE's data = "search_as_feature"
   - A filter dropdown that changes what data is displayed in a table/list below it = "table_filter"
   - If unsure, look at WHERE the element is positioned. Header/navbar = navigation. Inside the content area = feature.

4. EMPTY_STATE: Is this page showing an empty state ("No data yet", "Create your first X")? If yes, what's the call-to-action?

5. CONNECTED_FEATURES: Based on what you see, does this page relate to other parts of the app? (e.g., "Changes here probably appear in an activity log", "This seems connected to billing/subscription")

6. PAGE_COMPLEXITY: simple (1 screenshot enough) | moderate (2 screenshots) | complex (3 screenshots needed)

Return as JSON with these exact fields:
{
  "page_purpose": "...",
  "user_goals": ["..."],
  "interactive_elements": [{"what": "...", "type": "...", "explore_action": "..."}],
  "empty_state": false,
  "empty_state_cta": null,
  "connected_features": ["..."],
  "page_complexity": "simple|moderate|complex"
}

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;

  const raw = await claudeVision(explorationPrompt, heroBase64, {
    system: "You are a senior technical writer exploring a web application page for the first time. You're trying to understand this page deeply — what it's for, what users can do here, and what would be most valuable to document.",
    maxTokens: 2000,
    temperature: 0,
  });

  const understanding = parseJsonResponse<PageUnderstanding>(raw);

  console.log(`[crawl] Page understanding for "${feature.name}":`);
  console.log(`  Purpose: ${understanding.page_purpose}`);
  console.log(`  User goals: ${understanding.user_goals.join(", ")}`);
  console.log(`  Interactive elements: ${understanding.interactive_elements.length}`);
  console.log(`  Complexity: ${understanding.page_complexity}`);
  if (understanding.empty_state) {
    console.log(`  Empty state detected. CTA: ${understanding.empty_state_cta ?? "none"}`);
  }

  // Quick exploration — learn what's behind interactive elements (no screenshots)
  const explorableElements = understanding.interactive_elements
    .filter((el) => el.type !== "navigation_search" && el.type !== "form_field")
    .slice(0, 3);

  for (const element of explorableElements) {
    try {
      if (element.type === "dropdown" || element.type === "table_filter") {
        await stagehand.act(
          `Click the ${element.what} to see its options`,
          { timeout: 8000 },
        );
        await new Promise((r) => setTimeout(r, 1000));
        try { await stagehand.act("Press the Escape key", { timeout: 3000 }); } catch { /* ok */ }
      } else if (element.type === "modal_trigger") {
        await stagehand.act(`Click ${element.what}`, { timeout: 8000 });
        await new Promise((r) => setTimeout(r, 1500));
        try { await stagehand.act("Press the Escape key", { timeout: 3000 }); } catch { /* ok */ }
      } else if (element.type === "tab") {
        await stagehand.act(`Click the ${element.what} tab`, { timeout: 8000 });
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch {
      // Exploration action failed, continue
    }

    // Navigate back to initial state for clean documentation
    try {
      await page.goto(fullUrl, {
        waitUntil: "networkidle",
        timeoutMs: PAGE_TIMEOUT_MS,
      });
      await waitForSettle(page);
    } catch {
      // Navigation back failed, continue anyway
    }
  }

  // If empty state detected, follow the CTA
  if (understanding.empty_state && understanding.empty_state_cta) {
    try {
      console.log(`[crawl] Following empty state CTA: ${understanding.empty_state_cta}`);
      await stagehand.act(understanding.empty_state_cta, { timeout: 10000 });
      await waitForSettle(page);
    } catch {
      console.log("[crawl] Empty state CTA failed, continuing with current state");
    }
  }

  return understanding;
}

// ---------------------------------------------------------------------------
// Phase 2: DOCUMENT — Plan and execute purposeful screenshots
// ---------------------------------------------------------------------------

async function planDocumentationScreenshots(
  feature: Feature,
  understanding: PageUnderstanding,
  heroBase64: string,
): Promise<ScreenshotPlan[]> {
  console.log(`[crawl] Phase 2: Planning documentation screenshots for "${feature.name}"...`);

  const planPrompt = `You explored the "${feature.name}" page and learned:
${JSON.stringify(understanding, null, 2)}

The hero screenshot (default state) is already captured.

Now plan the documentation screenshots. For each screenshot you want:

1. DESCRIPTION: What state should the page be in? Be extremely specific.
2. ACTIONS: Exact sequence of Stagehand actions to reach this state. Use specific field labels and button text from what you observed.
3. VALUE: One sentence — what does this screenshot TEACH the reader that the hero doesn't?
4. SUBMIT_AFTER: Should I click a submit/save button after filling?
   - YES if: saving settings, creating an event/item, updating a profile — these show the user the result of their action
   - NO if: the submit would send a message/email/notification to another person, delete data, change billing, or have irreversible consequences
5. CAPTURE_RESULT: After submitting, should I take ANOTHER screenshot of the result state?
   - YES if: there's a success message, the page updates to show the new data, a new item appears in a list
   - NO if: the result looks the same as before

Rules:
- Maximum 2 action screenshots (plus the hero = 3 total max)
- NEVER plan a screenshot that would look identical to the hero or to another planned screenshot
- NEVER plan typing meaningless text into a navigation search bar — that teaches the reader nothing
- If the page is read-only with no meaningful interactions (just displays data), plan 0 action screenshots — the hero is enough
- If there's a creation flow (Add Event, Create Project, Invite Member), that's the MOST valuable screenshot — show the form filled with realistic data
- If there's a chart, the most valuable screenshot is hovering to show the tooltip with real data values
- If there's a filter that changes displayed data, the most valuable screenshot is showing filtered results
- If there's a modal, show it open — but only if the modal has meaningful content (a form, settings, etc.)
- Each screenshot must teach something DIFFERENT

For form filling, use contextually appropriate data:
- Names: "Sarah Johnson", "Alex Chen", "Maria Garcia"
- Emails: "sarah@company.com", "alex.chen@acmecorp.io"
- Phone: "+1 (415) 555-0192"
- Dates: use a realistic near-future date
- Event titles: "Q4 Planning Review", "Team Standup", "Client Onboarding"
- Project names: "Website Redesign", "Mobile App v2.0"
- Descriptions: "Review quarterly objectives and align on priorities for next sprint."
- URLs: "https://linkedin.com/in/sarahjohnson"
- NEVER use "Sample text for testing", "test", "Jane Smith in search bar", or any placeholder-feeling text

Return as JSON array of screenshot plans. Empty array [] if hero is sufficient.

Format:
[
  {
    "description": "...",
    "actions": ["action 1", "action 2"],
    "value": "...",
    "submit_after": false,
    "capture_result": false
  }
]

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;

  const raw = await claudeVision(planPrompt, heroBase64, {
    system: "You are a senior technical writer. You've just explored this page and understand it deeply. Now plan exactly which screenshots to take to create excellent documentation.",
    maxTokens: 2000,
    temperature: 0,
  });

  const plans = parseJsonResponse<ScreenshotPlan[]>(raw);

  console.log(`[crawl] Documentation plan for "${feature.name}": ${plans.length} action screenshots`);
  for (const plan of plans) {
    console.log(`  - ${plan.description} (value: ${plan.value})`);
  }

  return plans;
}

interface TwoPhaseResult {
  screens: ScreenRecord[];
  understanding: PageUnderstanding;
  screenshotDescriptions: string[];
}

async function executeDocumentationPlan(
  stagehand: Stagehand,
  page: Page,
  feature: Feature,
  jobId: string,
  codeContext: Record<string, unknown> | null,
  heroBuffer: Buffer,
  understanding: PageUnderstanding,
  plans: ScreenshotPlan[],
  startOrderIndex: number,
  fullUrl: string,
): Promise<{ screens: ScreenRecord[]; descriptions: string[] }> {
  const screens: ScreenRecord[] = [];
  const descriptions: string[] = ["hero (default state)"];
  let orderIndex = startOrderIndex;

  for (let pi = 0; pi < plans.length; pi++) {
    const plan = plans[pi];
    console.log(`[crawl] Executing screenshot plan ${pi + 1}/${plans.length}: ${plan.description}`);
    try {
      await page.goto(fullUrl, { waitUntil: "networkidle", timeoutMs: PAGE_TIMEOUT_MS });
      await waitForContentLoaded(page);
    } catch {
      console.log(`[crawl] Navigation timeout during plan execution, continuing`);
    }

    // Dismiss any overlays
    await dismissOverlays(page, stagehand);

    // Scroll to top for consistent starting position
    await page.evaluate(() => (globalThis as any).window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 500));

    // Execute the planned actions
    let actionsFailed = false;
    for (const action of plan.actions) {
      try {
        await stagehand.act(action, { timeout: 15000 });
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        console.log(`[crawl] Action failed: ${action} — ${err}. Skipping this plan.`);
        actionsFailed = true;
        break;
      }
    }

    if (actionsFailed) continue;

    await waitForContentLoaded(page);

    // Verify the page actually changed (content area comparison)
    const actionBuffer = await takeScreenshot(page);
    const changed = await hasPageMeaningfullyChanged(heroBuffer, actionBuffer);
    if (!changed) {
      console.log(`[crawl] Screenshot identical to hero after "${plan.description}" — discarding`);
      continue;
    }

    // Store the action screenshot
    const actionLabel = `action-${pi + 1}`;
    const filename = `${feature.slug}-${actionLabel}.png`;
    const result = await captureScreen(page, jobId, {
      featureId: feature.id,
      featureSlug: feature.slug,
      screenshotLabel: actionLabel,
      navPath: `${feature.name} (${plan.description})`,
      screenType: "page",
      codeContext,
      orderIndex,
      broadcastLabel: `${feature.name} — ${plan.description}`,
      descriptiveFilename: filename,
      skipDuplicateCheck: true,
    });

    if (result) {
      screens.push(result.record);
      orderIndex++;
      descriptions.push(plan.description);

      // If submit was planned
      if (plan.submit_after) {
        try {
          console.log(`[crawl] Submitting after "${plan.description}"...`);
          await stagehand.act(
            "Click the submit, save, or confirm button",
            { timeout: 10000 },
          );
          await waitForContentLoaded(page);
          await new Promise((r) => setTimeout(r, 2000));

          if (plan.capture_result) {
            const resultBuffer = await takeScreenshot(page);
            const resultChanged = await hasPageMeaningfullyChanged(actionBuffer, resultBuffer);
            if (resultChanged) {
              const resultFilename = `${feature.slug}-result-${pi + 1}.png`;
              const resultResult = await captureScreen(page, jobId, {
                featureId: feature.id,
                featureSlug: feature.slug,
                screenshotLabel: `result-${pi + 1}`,
                navPath: `${feature.name} (${plan.description} result)`,
                screenType: "page",
                codeContext,
                orderIndex,
                broadcastLabel: `${feature.name} — ${plan.description} (result)`,
                descriptiveFilename: resultFilename,
                skipDuplicateCheck: true,
              });
              if (resultResult) {
                screens.push(resultResult.record);
                orderIndex++;
                descriptions.push(`${plan.description} (result)`);
              }
            }
          }
        } catch (err) {
          console.log(`[crawl] Submit failed after "${plan.description}": ${err}`);
        }
      }
    }
  }

  return { screens, descriptions };
}

// ---------------------------------------------------------------------------
// Two-phase feature crawl — EXPLORE then DOCUMENT
// ---------------------------------------------------------------------------

async function twoPhaseFeatureCrawl(
  stagehand: Stagehand,
  page: Page,
  feature: Feature,
  jobId: string,
  codeContext: Record<string, unknown> | null,
  heroBuffer: Buffer,
  startOrderIndex: number,
  fullUrl: string,
): Promise<TwoPhaseResult> {
  const startTime = Date.now();
  // Reset comparison call counter for this feature
  comparisonCallsThisFeature = 0;

  const heroBase64 = heroBuffer.toString("base64");

  // --- PHASE 1: Explore ---
  let understanding: PageUnderstanding;
  try {
    understanding = await explorePage(stagehand, page, feature, heroBase64, fullUrl);
  } catch (err) {
    console.log(`[crawl] Phase 1 exploration failed for "${feature.name}": ${err}. Using minimal understanding.`);
    understanding = {
      page_purpose: `${feature.name} page`,
      user_goals: [],
      interactive_elements: [],
      empty_state: false,
      connected_features: [],
      page_complexity: "simple",
    };
  }

  // --- PHASE 2: Plan + Execute Documentation ---
  let screens: ScreenRecord[] = [];
  let descriptions: string[] = ["hero (default state)"];

  if (understanding.page_complexity !== "simple" || understanding.interactive_elements.length > 0) {
    try {
      // Reset to clean state before planning screenshots
      try {
        await page.goto(fullUrl, { waitUntil: "networkidle", timeoutMs: PAGE_TIMEOUT_MS });
        await waitForContentLoaded(page);
      } catch {
        // Navigation timeout is OK
      }

      // Re-take hero for comparison (page may have changed during exploration)
      await dismissOverlays(page, stagehand);
      await page.evaluate(() => (globalThis as any).window.scrollTo(0, 0));
      await new Promise((r) => setTimeout(r, 500));
      const freshHero = await takeScreenshot(page);
      const freshHeroBase64 = freshHero.toString("base64");

      const plans = await planDocumentationScreenshots(feature, understanding, freshHeroBase64);

      if (plans.length > 0) {
        const result = await executeDocumentationPlan(
          stagehand,
          page,
          feature,
          jobId,
          codeContext,
          freshHero,
          understanding,
          plans,
          startOrderIndex,
          fullUrl,
        );
        screens = result.screens;
        descriptions = [...descriptions, ...result.descriptions.slice(1)]; // skip duplicate "hero"
      }
    } catch (err) {
      console.log(`[crawl] Phase 2 documentation failed for "${feature.name}": ${err}`);
    }
  } else {
    console.log(`[crawl] Simple page "${feature.name}" — hero screenshot is sufficient`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[crawl] Feature "${feature.name}" two-phase crawl: ${screens.length} action screenshots in ${elapsed}s`);

  return { screens, understanding, screenshotDescriptions: descriptions };
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
    const featureUnderstandings: FeatureUnderstanding[] = [];

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

        // --- Dismiss overlays before hero screenshot ---
        await dismissOverlays(page, stagehand);

        // --- Wait for content to load ---
        await waitForContentLoaded(page);

        // --- Scroll to top for consistent starting position ---
        await page.evaluate(() => (globalThis as any).window.scrollTo(0, 0));
        await new Promise((r) => setTimeout(r, 500));

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

        // --- TWO-PHASE EXPLORATION: explore → understand → document ---
        if (screens.length < maxScreens) {
          const heroBuffer = await takeScreenshot(page);
          await broadcastProgress(config.jobId, "info", `Exploring ${feature.name}...`);

          const twoPhaseResult = await twoPhaseFeatureCrawl(
            stagehand,
            page,
            feature,
            config.jobId,
            codeContext,
            heroBuffer,
            orderIndex,
            fullUrl,
          );

          screens.push(...twoPhaseResult.screens);
          orderIndex += twoPhaseResult.screens.length;

          // Store feature understanding for appUnderstanding
          featureUnderstandings.push({
            name: feature.name,
            slug: feature.slug,
            purpose: twoPhaseResult.understanding.page_purpose,
            userGoals: twoPhaseResult.understanding.user_goals,
            connectedFeatures: twoPhaseResult.understanding.connected_features,
            screenshotDescriptions: twoPhaseResult.screenshotDescriptions,
          });
        }

        console.log(`[crawl] Feature "${feature.name}" complete`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : (typeof err === "object" ? JSON.stringify(err) : String(err));
        console.error(`[crawl] Feature "${feature.name}" failed: ${errMsg}`);
        errors.push({
          featureId: feature.id,
          action: `crawl ${feature.name}`,
          error: errMsg,
        });
        await broadcastProgress(config.jobId, "error", `Failed to document ${feature.name}: ${errMsg}`);
      }
    }

    // ----- Build app understanding -----
    const appUnderstanding: AppUnderstanding = {
      appName: "", // Will be set by orchestrator
      features: featureUnderstandings,
    };

    console.log(`\n[crawl] === App Understanding ===`);
    for (const fu of featureUnderstandings) {
      console.log(`  ${fu.name}: ${fu.purpose}`);
      console.log(`    Goals: ${fu.userGoals.join(", ")}`);
      console.log(`    Connected: ${fu.connectedFeatures.join(", ") || "none"}`);
      console.log(`    Screenshots: ${fu.screenshotDescriptions.join(", ")}`);
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

    return { screens, errors, totalDurationMs, appUnderstanding };
  } finally {
    await closeStagehand();
  }
}
