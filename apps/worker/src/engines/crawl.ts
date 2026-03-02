import { Stagehand, Page } from "@browserbasehq/stagehand";
import { z } from "zod";
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
  FEATURE_TIMEOUT_MS,
} from "@docuagent/shared";
// claude.js imports no longer needed for crawl — agent() handles AI calls internally
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
// Agent-based exploration types
// ---------------------------------------------------------------------------

export interface PageUnderstanding {
  purpose: string;
  userGoals: string[];
  pageType: string;
  interactionsPerformed: { action: string; result: string; useful: boolean }[];
  connectedFeatures: string[];
  hasSubmittableForm: boolean;
  isReadOnly: boolean;
}

const PageUnderstandingSchema = z.object({
  purpose: z.string().describe("1-2 sentences: what is this page for? What real-world problem does it solve?"),
  userGoals: z.array(z.string()).describe("2-4 things a user would come to this page to accomplish"),
  pageType: z.enum([
    "dashboard", "form", "table", "chart", "profile", "calendar",
    "settings", "list", "detail", "empty_state", "component_showcase",
    "inbox", "activity_log", "search", "kanban", "editor", "other",
  ]).describe("The type of page"),
  interactionsPerformed: z.array(z.object({
    action: z.string().describe("What I did"),
    result: z.string().describe("What happened"),
    useful: z.boolean().describe("Did this change the page visually?"),
  })).describe("Interactions I performed"),
  connectedFeatures: z.array(z.string()).describe("Other app features this page relates to"),
  hasSubmittableForm: z.boolean().describe("Is there a form with a safe submit button?"),
  isReadOnly: z.boolean().describe("Is this page purely informational with no meaningful interactions?"),
});

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
    const actions = await Promise.race([
      stagehand.observe(
        "Find all navigation links in the sidebar, top navigation bar, header, and any dropdown menus. Return each link with its text and URL.",
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Observe timeout")), 15_000)),
    ]);

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
// Screenshot comparison — byte-level (no AI calls)
// ---------------------------------------------------------------------------

function isScreenshotDifferent(a: Buffer, b: Buffer): boolean {
  // Size difference > 5KB = definitely different
  if (Math.abs(a.length - b.length) > 5000) return true;

  // Compare middle section of image (skips header/footer which may be identical)
  const midA = Math.floor(a.length / 2);
  const midB = Math.floor(b.length / 2);
  const rangeA = Math.min(2000, Math.floor(a.length / 4));
  const rangeB = Math.min(2000, Math.floor(b.length / 4));
  const sampleA = a.slice(midA - rangeA, midA + rangeA).toString("hex");
  const sampleB = b.slice(midB - rangeB, midB + rangeB).toString("hex");

  return sampleA !== sampleB;
}

function hashScreenshot(buffer: Buffer): string {
  const mid = Math.floor(buffer.length / 2);
  const range = Math.min(1000, Math.floor(buffer.length / 4));
  const sample = buffer.slice(mid - range, mid + range);
  return crypto.createHash("md5").update(sample).digest("hex");
}

// ---------------------------------------------------------------------------
// URL verification — check if we're still on the right page
// ---------------------------------------------------------------------------

function isOnSamePage(current: string, expected: string): boolean {
  try {
    const c = new URL(current);
    const e = new URL(expected);
    return c.host === e.host && c.pathname === e.pathname;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Loading screen detection — check if page is still loading
// ---------------------------------------------------------------------------

async function isPageLoading(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const d = (globalThis as any).document;
      const body = d.body;

      // Check for loading indicators
      const selectors = [
        '[class*="loading"]', '[class*="spinner"]', '[class*="skeleton"]',
        '[class*="Loading"]', '[class*="Spinner"]',
        '.animate-pulse', '.animate-spin',
        '[role="progressbar"]', '[aria-busy="true"]',
      ];
      for (const sel of selectors) {
        const el = d.querySelector(sel);
        if (el && el.offsetHeight > 0 && el.offsetWidth > 0) return true;
      }

      // Very little visible text = probably loading
      const text = body.innerText?.trim() || "";
      if (text.length < 50) return true;

      // Single centered image with no content = splash screen
      const imgs = d.querySelectorAll("img");
      if (imgs.length <= 2 && text.length < 100) return true;

      return false;
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// External app detection
// ---------------------------------------------------------------------------

function isExternalApp(appUrl: string): boolean {
  return !appUrl.includes("localhost") && !appUrl.includes("127.0.0.1");
}

// ---------------------------------------------------------------------------
// Agent system prompt for page exploration
// ---------------------------------------------------------------------------

const AGENT_SYSTEM_PROMPT = `You are a senior technical writer exploring a web application page to create documentation. You must deeply understand every page you visit.

YOUR TOOLS:
- think: ALWAYS use this first to reason about what you see before acting
- act: Perform a single action (click, type, select)
- fillForm: Fill all form fields at once with realistic data
- extract: Get structured data from the page
- scroll: Scroll to see more content
- wait: Wait for loading/animations to finish
- screenshot: Take a screenshot
- navback: Go back if you navigated away

WORKFLOW FOR EVERY PAGE:
1. First, THINK: "What is this page? What can users do here? What would be most valuable to document?"
2. If you see a loading spinner or skeleton, WAIT 3-5 seconds
3. Interact with the most documentation-worthy elements:
   - Forms → use fillForm with realistic data (Sarah Johnson, sarah@company.com, +1 415 555 0192, Q4 Planning Review)
   - Chart → hover over a data point to show tooltip
   - Modal trigger (Add/Create/Edit button) → click to open, fill any form inside
   - Tabs → click to see different views
   - Filters that change displayed data → use one
   - Expandable sections → expand them
4. If the page is read-only (displays data, logs, charts with no interactions), that is FINE — just observe and report
5. NEVER interact with the header search bar, sidebar navigation, or global nav elements
6. NEVER click Delete, Remove, Send, Invite, Share, or Pay buttons
7. You MAY click Save, Create, Add, Submit, Update, Apply, Confirm buttons
8. Maximum 8 actions per page. Stop when you've captured the most valuable interactions.`;

// ---------------------------------------------------------------------------
// Safe agent execution with error handling
// ---------------------------------------------------------------------------

async function safeAgentExecute(
  stagehand: Stagehand,
  agentConfig: { model?: string; systemPrompt?: string },
  executeOpts: { instruction: string; maxSteps?: number; signal?: AbortSignal; output?: z.ZodObject<any> },
  page: Page,
  featureUrl: string,
): Promise<{ success: boolean; message: string; actions: any[]; output?: Record<string, unknown> } | null> {
  const agent = stagehand.agent({
    model: agentConfig.model ?? "anthropic/claude-sonnet-4-6",
    systemPrompt: agentConfig.systemPrompt ?? AGENT_SYSTEM_PROMPT,
  });

  try {
    return await agent.execute(executeOpts);
  } catch (err: any) {
    if (err.message?.includes("429") || err.message?.includes("rate_limit")) {
      console.log("[crawl] Rate limited. Waiting 60s...");
      await new Promise((r) => setTimeout(r, 60000));
      try {
        return await agent.execute(executeOpts);
      } catch (retryErr: any) {
        console.log(`[crawl] Agent retry failed: ${retryErr.message}`);
      }
    } else if (err.name === "AgentAbortError" || err.message?.includes("aborted")) {
      console.log("[crawl] Agent timed out.");
    } else {
      console.log(`[crawl] Agent error: ${err.message}`);
    }
    // Navigate back to correct page
    try {
      await page.goto(featureUrl, { waitUntil: "networkidle", timeoutMs: 10000 });
    } catch { /* even this failed, but continue */ }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent-based feature exploration — replaces two-phase crawl
// ---------------------------------------------------------------------------

interface AgentCrawlResult {
  screens: ScreenRecord[];
  understanding: PageUnderstanding | null;
  screenshotDescriptions: string[];
}

async function agentFeatureCrawl(
  stagehand: Stagehand,
  page: Page,
  feature: Feature,
  jobId: string,
  codeContext: Record<string, unknown> | null,
  heroBuffer: Buffer,
  startOrderIndex: number,
  fullUrl: string,
  appUrl: string,
): Promise<AgentCrawlResult> {
  const startTime = Date.now();
  const external = isExternalApp(appUrl);
  const screenshots: { buffer: Buffer; description: string; filename: string }[] = [];
  const allCapturedHashes = new Set<string>();
  const descriptions: string[] = ["hero (default state)"];

  // Hash the hero screenshot
  const heroHash = hashScreenshot(heroBuffer);
  allCapturedHashes.add(heroHash);

  // ---- Phase 2: Agent exploration with structured output ----
  console.log(`[crawl] Agent exploring "${feature.name}"...`);

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort("Timeout"), external ? 180000 : 120000);

  let understanding: PageUnderstanding | null = null;
  try {
    const result = await safeAgentExecute(
      stagehand,
      { model: "anthropic/claude-sonnet-4-6", systemPrompt: AGENT_SYSTEM_PROMPT },
      {
        instruction: `Explore the "${feature.name}" page. Understand its purpose, interact with its key elements, and report what you found and did.`,
        maxSteps: 10,
        signal: timeout.signal,
        output: PageUnderstandingSchema,
      },
      page,
      fullUrl,
    );

    if (result?.output) {
      understanding = result.output as unknown as PageUnderstanding;
      console.log(`[crawl] Agent explored ${feature.name}: ${result.message}`);
      console.log(`[crawl] Understanding: purpose="${understanding.purpose}", pageType="${understanding.pageType}", goals=${understanding.userGoals.length}, interactions=${understanding.interactionsPerformed.length}`);
    } else if (result) {
      console.log(`[crawl] Agent completed but no structured output for ${feature.name}: ${result.message}`);
    }
  } catch (err: any) {
    console.log(`[crawl] Agent error on ${feature.name}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // ---- Phase 3: Post-exploration screenshot with 3-layer verification ----
  const currentUrl = page.url();
  if (!isOnSamePage(currentUrl, fullUrl)) {
    console.log(`[crawl] Agent navigated away from ${feature.name}. Going back.`);
    try {
      await page.goto(fullUrl, { waitUntil: "networkidle", timeoutMs: 15000 });
      await new Promise((r) => setTimeout(r, external ? 5000 : 2000));
    } catch { /* navigation failed */ }
  }

  const postBuffer = await takeScreenshot(page);

  // Layer 1: Not a loading screen
  const loading = await isPageLoading(page);
  // Layer 2: Content area different from hero
  const different = !loading && isScreenshotDifferent(heroBuffer, postBuffer);
  // Layer 3: Not a cross-feature duplicate
  const postHash = hashScreenshot(postBuffer);
  const duplicate = allCapturedHashes.has(postHash);

  if (!loading && different && !duplicate) {
    allCapturedHashes.add(postHash);
    screenshots.push({
      buffer: postBuffer,
      description: `${feature.name} after interaction`,
      filename: `${feature.slug}-action-1.png`,
    });
    descriptions.push(`${feature.name} after interaction`);
    console.log(`[crawl] ✓ Action screenshot captured for ${feature.name}`);
  } else {
    console.log(`[crawl] ✗ Post-exploration screenshot skipped: ${loading ? "loading" : !different ? "identical" : "duplicate"}`);
  }

  // ---- Phase 4: Form submission and result capture ----
  if (understanding?.hasSubmittableForm && !understanding?.isReadOnly) {
    console.log(`[crawl] Attempting form submission for ${feature.name}...`);
    try {
      await page.goto(fullUrl, { waitUntil: "networkidle", timeoutMs: 15000 });
      await new Promise((r) => setTimeout(r, external ? 5000 : 2000));
    } catch { /* navigation timeout ok */ }

    const submitTimeout = new AbortController();
    const submitTimer = setTimeout(() => submitTimeout.abort(), external ? 90000 : 60000);

    try {
      const submitResult = await safeAgentExecute(
        stagehand,
        {
          model: "anthropic/claude-sonnet-4-6",
          systemPrompt: "You fill forms and submit them. Use realistic data. Never send messages, delete data, or make payments.",
        },
        {
          instruction: "Fill all form fields with realistic data, then click the Save/Submit/Create button. If no safe submit button exists, do nothing.",
          maxSteps: 8,
          signal: submitTimeout.signal,
        },
        page,
        fullUrl,
      );

      if (submitResult) {
        await new Promise((r) => setTimeout(r, 3000));

        const resultBuffer = await takeScreenshot(page);
        const resultHash = hashScreenshot(resultBuffer);
        const resultLoading = await isPageLoading(page);
        if (!resultLoading && isScreenshotDifferent(heroBuffer, resultBuffer) && !allCapturedHashes.has(resultHash)) {
          allCapturedHashes.add(resultHash);
          screenshots.push({
            buffer: resultBuffer,
            description: `${feature.name} after submission`,
            filename: `${feature.slug}-result-1.png`,
          });
          descriptions.push(`${feature.name} after submission`);
          console.log(`[crawl] ✓ Result screenshot captured for ${feature.name}`);
        }
      }
    } catch {
      /* timeout or failure — acceptable */
    } finally {
      clearTimeout(submitTimer);
    }
  }

  // ---- Store screenshots ----
  const screens: ScreenRecord[] = [];
  let orderIndex = startOrderIndex;

  for (const shot of screenshots) {
    const screenshotUrl = await uploadScreenshot(jobId, shot.buffer, shot.filename);
    if (!screenshotUrl) continue;

    const dom = await cleanDom(page);
    const record: ScreenRecord = {
      id: "",
      url: page.url(),
      routePath: new URL(page.url()).pathname,
      navPath: `${feature.name} (${shot.description})`,
      screenshotUrl,
      domHtml: dom,
      codeContext,
      screenType: "page",
      featureId: feature.id,
      featureSlug: feature.slug,
      screenshotLabel: shot.filename.replace(`${feature.slug}-`, "").replace(".png", ""),
      createdEntityId: null,
      status: "crawled",
      orderIndex,
    };

    const id = await storeScreen(jobId, record);
    record.id = id;
    screens.push(record);
    orderIndex++;

    await broadcastProgress(
      jobId,
      "screenshot",
      `Captured: ${feature.name} — ${shot.description}`,
      screenshotUrl,
    );
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[crawl] Feature "${feature.name}" agent crawl: ${screens.length} action screenshots in ${elapsed}s`);

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
        // Wrap the entire feature crawl in a hard timeout
        await Promise.race([
          (async () => {
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
          return;
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
              return;
            }
            // Retry navigation
            await page.goto(fullUrl, { waitUntil: "networkidle", timeoutMs: PAGE_TIMEOUT_MS });
            await waitForSettle(page);
          } else if (hasLoginFields) {
            errors.push({ featureId: feature.id, action: "navigate", error: "Session expired, re-auth cap reached" });
            return;
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

        // --- Wait for initial page load ---
        const external = isExternalApp(config.appUrl);
        await page.evaluate(() => (globalThis as any).window.scrollTo(0, 0));
        await new Promise((r) => setTimeout(r, external ? 5000 : 2000));

        // --- Dismiss overlays before hero screenshot ---
        try {
          await stagehand.act("Close any cookie banner, popup, notification, or overlay blocking the main content", { timeout: 5000 });
        } catch { /* no overlay */ }

        // --- Wait for content to load (with loading screen retry) ---
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!await isPageLoading(page)) break;
          console.log(`[crawl] Loading detected for ${feature.name} (attempt ${attempt + 1}/3). Waiting 5s...`);
          await new Promise((r) => setTimeout(r, 5000));
        }

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

        // --- AGENT EXPLORATION: autonomous page exploration + screenshot capture ---
        if (screens.length < maxScreens) {
          const heroBuffer = await takeScreenshot(page);
          await broadcastProgress(config.jobId, "info", `Exploring ${feature.name}...`);

          const agentResult = await agentFeatureCrawl(
            stagehand,
            page,
            feature,
            config.jobId,
            codeContext,
            heroBuffer,
            orderIndex,
            fullUrl,
            config.appUrl,
          );

          screens.push(...agentResult.screens);
          orderIndex += agentResult.screens.length;

          // Store feature understanding for appUnderstanding
          featureUnderstandings.push({
            name: feature.name,
            slug: feature.slug,
            purpose: agentResult.understanding?.purpose ?? `${feature.name} page`,
            userGoals: agentResult.understanding?.userGoals ?? [],
            connectedFeatures: agentResult.understanding?.connectedFeatures ?? [],
            screenshotDescriptions: agentResult.screenshotDescriptions,
          });
        }

        // --- Sub-pages: if this is a grouped feature, visit each additional sub-page ---
        if (feature.subPages && feature.subPages.length > 1) {
          // First sub-page was already crawled above (it's the primary route)
          for (let si = 1; si < feature.subPages.length; si++) {
            if (screens.length >= maxScreens) break;

            const subPage = feature.subPages[si];
            const subUrl = subPage.route.startsWith("http")
              ? subPage.route
              : `${config.appUrl.replace(/\/$/, "")}${subPage.route}`;

            console.log(`[crawl] Sub-page: ${subPage.name} (${si + 1}/${feature.subPages.length})`);
            await broadcastProgress(config.jobId, "info", `Capturing ${feature.name} — ${subPage.name}`);

            try {
              await page.goto(subUrl, { waitUntil: "networkidle", timeoutMs: PAGE_TIMEOUT_MS });
              await waitForSettle(page);
              await dismissOverlays(page, stagehand);
              await waitForContentLoaded(page);
              await page.evaluate(() => (globalThis as any).window.scrollTo(0, 0));
              await new Promise((r) => setTimeout(r, 500));

              const subSlug = `${feature.slug}-${subPage.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
              const subResult = await captureScreen(page, config.jobId, {
                featureId: feature.id,
                featureSlug: feature.slug,
                screenshotLabel: subPage.name,
                navPath: `${feature.name} > ${subPage.name}`,
                screenType: "page",
                codeContext: null,
                orderIndex,
                broadcastLabel: `${feature.name} — ${subPage.name}`,
                descriptiveFilename: `${subSlug}.png`,
              });
              if (subResult) {
                screens.push(subResult.record);
                orderIndex++;
              }

              // Run agent exploration on sub-pages too
              if (screens.length < maxScreens) {
                const subHero = await takeScreenshot(page);
                const subAgentResult = await agentFeatureCrawl(
                  stagehand, page, { ...feature, name: subPage.name },
                  config.jobId, null, subHero, orderIndex, subUrl, config.appUrl,
                );
                screens.push(...subAgentResult.screens);
                orderIndex += subAgentResult.screens.length;
              }
            } catch (err) {
              console.log(`[crawl] Sub-page ${subPage.name} failed: ${err}`);
            }
          }
        }

        console.log(`[crawl] Feature "${feature.name}" complete`);
          })(), // end of async IIFE
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`Feature timeout after ${FEATURE_TIMEOUT_MS / 1000}s`)), FEATURE_TIMEOUT_MS),
          ),
        ]); // end of Promise.race
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : (typeof err === "object" ? JSON.stringify(err) : String(err));
        const isTimeout = errMsg.includes("Feature timeout");
        console.error(`[crawl] Feature "${feature.name}" ${isTimeout ? "TIMED OUT" : "failed"}: ${errMsg}`);
        errors.push({
          featureId: feature.id,
          action: `crawl ${feature.name}`,
          error: errMsg,
        });
        await broadcastProgress(
          config.jobId,
          "error",
          isTimeout
            ? `${feature.name} timed out after ${FEATURE_TIMEOUT_MS / 1000}s — moving on`
            : `Failed to document ${feature.name}: ${errMsg}`,
        );

        // After a timeout, navigate back to app root to reset browser state
        if (isTimeout) {
          try {
            await page.goto(config.appUrl, { waitUntil: "networkidle", timeoutMs: 10000 });
          } catch {
            // Even navigation failed, but we continue
          }
        }
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
