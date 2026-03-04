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
import { claudeVisionMulti } from "../lib/claude.js";
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
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeoutMs: PAGE_TIMEOUT_MS });
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
      await page.goto(testUrl, { waitUntil: "domcontentloaded", timeoutMs: 10_000 });
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
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeoutMs: PAGE_TIMEOUT_MS });
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
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeoutMs: PAGE_TIMEOUT_MS });
  await waitForSettle(page);

  const priorUrl = page.url();

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.log("[crawl] Retrying login...");
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeoutMs: PAGE_TIMEOUT_MS });
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

async function isPaywallModal(screenshotBuffer: Buffer): Promise<boolean> {
  try {
    const base64 = screenshotBuffer.toString("base64");
    const response = await claudeVisionMulti(
      "Look at this screenshot structurally. Is there a modal dialog, popup, or overlay COVERING the main content area of the page? A modal overlay has these characteristics: it darkens or blurs the background, it has a visible close button (X), it blocks interaction with the page behind it, and it is centered or floating above the content.\n\nIMPORTANT: Buttons, banners, or links in the SIDEBAR or HEADER that say \"upgrade\", \"try pro\", or \"start trial\" are NORMAL UI — they do NOT count. Only a floating modal/dialog/overlay blocking the main content counts.\n\nAnswer YES only if a modal overlay is covering the main content. Answer NO if the main content area is visible and not blocked. Reply with ONLY YES or NO.",
      [{ mediaType: "image/png", data: base64 }],
      {
        maxTokens: 5,
        system: "You detect modal overlays in web application screenshots. Answer only YES or NO.",
        model: "claude-haiku-4-5-20251001",
      },
    );
    const answer = response.trim().toUpperCase();
    return answer === "YES";
  } catch {
    return false;
  }
}

async function getPerceptualSimilarity(
  heroBuffer: Buffer,
  candidateBuffer: Buffer,
): Promise<number> {
  const sizeDiff = Math.abs(heroBuffer.length - candidateBuffer.length) / Math.max(heroBuffer.length, candidateBuffer.length);
  if (sizeDiff > 0.1) return 0;

  try {
    const heroBase64 = heroBuffer.toString("base64");
    const candidateBase64 = candidateBuffer.toString("base64");

    const response = await claudeVisionMulti(
      "Rate the visual similarity between these two screenshots. 10 = identical content (ignore minor rendering differences like cursor or highlight changes). 1 = completely different content (different forms, data, or page state). Reply with ONLY a single number.",
      [
        { mediaType: "image/png", data: heroBase64 },
        { mediaType: "image/png", data: candidateBase64 },
      ],
      {
        maxTokens: 5,
        system: "You compare screenshots. Answer only with a number 1-10.",
        model: "claude-haiku-4-5-20251001",
      },
    );

    const score = parseInt(response.trim(), 10);
    return isNaN(score) ? 0 : score;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// URL verification — check if we're still on the right page
// ---------------------------------------------------------------------------

function isOnSamePage(current: string, expected: string): boolean {
  try {
    const c = new URL(current);
    const e = new URL(expected);
    if (c.host !== e.host) return false;
    // Exact pathname match
    if (c.pathname === e.pathname) return true;
    // Sub-path match: /inbox/task/123 is a sub-page of /inbox
    if (c.pathname.startsWith(e.pathname + '/')) return true;
    // Hash routing: #/inbox vs #/today
    if (c.hash && e.hash && c.hash !== e.hash) return false;
    if (c.hash && e.hash && c.hash === e.hash) return true;
    return false;
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

      // Find the main content area (not sidebar/header)
      const mainSelectors = [
        'main', '[role="main"]', '.main-content', '#content',
        '.content-area', '.page-content', '#main',
      ];
      let mainContent: any = null;
      for (const sel of mainSelectors) {
        mainContent = d.querySelector(sel);
        if (mainContent) break;
      }

      // Fallback: largest non-nav div
      if (!mainContent) {
        const divs = Array.from(d.querySelectorAll('div')) as any[];
        mainContent = divs
          .filter((div: any) => !div.closest('nav, aside, header, footer, [role="navigation"]'))
          .filter((div: any) => div.offsetWidth > 200 && div.offsetHeight > 100)
          .sort((a: any, b: any) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0];
      }
      if (!mainContent) mainContent = d.body;

      // Check for spinners/loaders in main content
      const loaderSelectors = [
        '[class*="loading"]', '[class*="spinner"]', '[class*="skeleton"]',
        '[class*="Loading"]', '[class*="Spinner"]', '[class*="loader"]', '[class*="Loader"]',
        '.animate-pulse', '.animate-spin',
        '[role="progressbar"]', '[aria-busy="true"]',
        'svg[class*="spin"]', 'svg[class*="load"]',
        'circle[class*="spin"]',
      ];

      for (const sel of loaderSelectors) {
        const el = mainContent.querySelector(sel);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 10 && rect.height > 10) return true;
        }
      }

      // Very little text in main content = probably loading
      const mainText = (mainContent.innerText || '').replace(/\s+/g, ' ').trim();
      if (mainText.length < 20) return true;

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

const AGENT_SYSTEM_PROMPT = `You are a senior technical writer exploring a web application page to document it for end users.

Your goal: deeply understand this page and interact with its most valuable elements to see how they work.

HOW TO EXPLORE:
1. First THINK about what this page is for and what users need to learn.
2. If you see a loading indicator, WAIT for it to finish.
3. Interact with the most documentation-worthy elements:
   - Forms: fill fields with realistic data (Sarah Johnson, sarah@company.com, +1 415 555 0192, Q4 Planning Review)
   - Buttons labeled Add/Create/Edit/New: click to open forms or modals
   - Charts: hover to reveal tooltips with exact values
   - Tabs or view toggles: click to see different content
   - Filters or dropdowns that change displayed data: try one
   - Expandable or collapsible sections: expand them
   - Tasks or list items: click one to see its detail view
4. You MAY click: Save, Create, Add, Submit, Update, Apply, Confirm
5. Do NOT click any button related to: Delete, Remove, Send, Invite, Share, Pay, Subscribe, Upgrade, Buy, Purchase, Start trial, Start free trial, Try Pro, Try for free, Checkout, Place order, Connect account, Activate, Import, Sync, Enable, Authorize, Link account, Sign up for, billing, payment, or subscription.
6. Do NOT send messages, emails, invitations, or notifications to real people.
7. Do NOT fill in payment forms, credit card fields, or billing addresses.
8. If you accidentally open a payment, subscription, or upgrade modal, close it immediately and move on.
9. Stop after 5-6 meaningful interactions. Quality over quantity.

You are free to explore whatever helps you understand the page. Report what this page does, what you interacted with, and what you learned.`;

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
      await page.goto(featureUrl, { waitUntil: "domcontentloaded", timeoutMs: 10000 });
    } catch { /* even this failed, but continue */ }
    return null;
  }
}

// ---------------------------------------------------------------------------
// SPA-friendly navigation helper
// ---------------------------------------------------------------------------

async function navigateToFeature(
  page: Page,
  stagehand: Stagehand,
  featureUrl: string,
  featureName: string,
  appUrl: string,
): Promise<void> {
  const external = isExternalApp(appUrl);

  // Strategy 1: Direct URL with domcontentloaded
  try {
    await page.goto(featureUrl, { waitUntil: "domcontentloaded", timeoutMs: 15000 });
    await new Promise(r => setTimeout(r, external ? 5000 : 2000));
    if (isOnSamePage(page.url(), featureUrl)) return;
  } catch { /* try next */ }

  // Strategy 2: Go to app root, then click the feature link
  try {
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeoutMs: 10000 });
    await new Promise(r => setTimeout(r, 2000));
    await stagehand.act(`Click the link or menu item for "${featureName}"`, { timeout: 10000 });
    await new Promise(r => setTimeout(r, external ? 5000 : 2000));
  } catch { /* try last resort */ }

  // Strategy 3: Just go and wait
  try {
    await page.goto(featureUrl, { timeoutMs: 20000 });
    await new Promise(r => setTimeout(r, 5000));
  } catch { /* we tried everything */ }
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
  globalScreenshotHashes: Set<string>,
): Promise<AgentCrawlResult> {
  const startTime = Date.now();
  const external = isExternalApp(appUrl);
  const screenshots: { buffer: Buffer; description: string; filename: string }[] = [];
  const descriptions: string[] = ["hero (default state)"];

  // ─── MONITORING STATE ───
  // The monitoring layer captures screenshots DURING agent exploration.
  // Two-tier system:
  //   Tier 1 (preferred): Screenshots where URL matches or is sub-path of feature URL
  //   Tier 2 (fallback): Screenshots where URL doesn't match (agent navigated away)
  // We keep the LAST valid candidate in each tier. Tier 1 always wins over Tier 2.
  let tier1Candidate: Buffer | null = null; // On correct page
  let tier2Candidate: Buffer | null = null; // Agent navigated away
  let tier1Description: string = "";
  let tier2Description: string = "";
  let stepCount = 0;

  // ─── MONITORING CALLBACK ───
  // Runs after EVERY agent action. Captures screenshots at the right moments
  // without restricting the agent's behavior.
  const monitorStep = async () => {
    stepCount++;
    try {
      // Small delay for the page to render after the agent's action
      await new Promise(r => setTimeout(r, 500));

      // Take screenshot of current state
      const buffer = await takeScreenshot(page);

      // Check 1: Is this a loading screen? Skip.
      const loading = await isPageLoading(page);
      if (loading) {
        console.log(`[monitor] Step ${stepCount}: loading screen, skipping`);
        return;
      }

      // Check 2: Is this a login/auth page? Skip.
      // (Catches session expiry during exploration)
      const currentUrl = page.url();
      if (isAuthPageUrl(currentUrl)) {
        console.log(`[monitor] Step ${stepCount}: auth page detected, skipping`);
        return;
      }

      // Check 2.5: Is this a paywall/upsell modal? Skip.
      const isPaywall = await isPaywallModal(buffer);
      if (isPaywall) {
        console.log(`[monitor] Step ${stepCount}: paywall/upsell modal detected, skipping`);
        return;
      }

      // Check 3: Is this visually the same as the hero? Skip.
      if (!isScreenshotDifferent(heroBuffer, buffer)) {
        console.log(`[monitor] Step ${stepCount}: same as hero, skipping`);
        return;
      }

      // Check 4: Is this a duplicate of any screenshot from any feature? Skip.
      const hash = hashScreenshot(buffer);
      if (globalScreenshotHashes.has(hash)) {
        console.log(`[monitor] Step ${stepCount}: cross-feature duplicate, skipping`);
        return;
      }

      // ALL CHECKS PASSED — assign to correct tier based on URL
      const onFeaturePage = isOnSamePage(currentUrl, fullUrl);
      if (onFeaturePage) {
        tier1Candidate = buffer;
        tier1Description = `${feature.name} after interaction (step ${stepCount})`;
        console.log(`[monitor] Step ${stepCount}: ✓ Tier 1 candidate (on correct page)`);
      } else {
        tier2Candidate = buffer;
        tier2Description = `${feature.name} after interaction (step ${stepCount})`;
        console.log(`[monitor] Step ${stepCount}: ✓ Tier 2 candidate (navigated away to ${currentUrl})`);
      }

    } catch (err) {
      // Monitoring must never crash the agent
      console.log(`[monitor] Step ${stepCount}: capture failed (${err}), continuing`);
    }
  };

  // ─── AGENT EXPLORATION ───
  console.log(`[crawl] Agent exploring "${feature.name}"...`);

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort("Timeout"), external ? 120000 : 75000);

  let understanding: PageUnderstanding | null = null;
  try {
    const agent = stagehand.agent({
      model: "anthropic/claude-sonnet-4-6",
      systemPrompt: AGENT_SYSTEM_PROMPT,
    });

    const result = await agent.execute({
      instruction: `Explore the "${feature.name}" page. Understand its purpose, interact with its key elements, and report what you found and did.`,
      maxSteps: 7,
      signal: timeout.signal,
      output: PageUnderstandingSchema,
      callbacks: {
        onStepFinish: async () => {
          await monitorStep();
        },
      },
    });

    if (result?.output) {
      understanding = result.output as unknown as PageUnderstanding;
      console.log(`[crawl] Agent explored ${feature.name}: ${result.message}`);
      console.log(`[crawl] Understanding: purpose="${understanding.purpose}", pageType="${understanding.pageType}", goals=${understanding.userGoals.length}, interactions=${understanding.interactionsPerformed.length}`);
    } else if (result) {
      console.log(`[crawl] Agent completed ${feature.name} without structured output: ${result.message}`);
    }
  } catch (err: any) {
    const msg = err.message || String(err);
    if (msg.includes("aborted") || msg.includes("Timeout") || err.name === "AgentAbortError") {
      console.log(`[crawl] Agent timed out for ${feature.name}`);
    } else if (msg.includes("429") || msg.includes("rate_limit")) {
      console.log(`[crawl] Rate limited during ${feature.name}. Waiting 60s...`);
      await new Promise(r => setTimeout(r, 60000));
    } else {
      console.log(`[crawl] Agent error on ${feature.name}: ${msg}`);
    }
    // Even if agent failed/timed out, we may have captured valid screenshots in the monitoring layer
  } finally {
    clearTimeout(timer);
  }

  // ─── COLLECT BEST SCREENSHOT ───
  // Prefer Tier 1 (on correct page) over Tier 2 (navigated away)
  const bestCandidate = tier1Candidate || tier2Candidate;
  const candidateTier = tier1Candidate ? "Tier 1 (correct page)" : "Tier 2 (navigated away)";

  if (bestCandidate) {
    const similarity = await getPerceptualSimilarity(heroBuffer, bestCandidate);
    if (similarity >= 9) {
      console.log(`[crawl] ✗ Action screenshot too similar to hero (${similarity}/10) for ${feature.name}, discarding`);
    } else {
      console.log(`[crawl] ✓ Action screenshot accepted (similarity: ${similarity}/10) for ${feature.name}`);
      const hash = hashScreenshot(bestCandidate);
      if (!globalScreenshotHashes.has(hash)) {
        globalScreenshotHashes.add(hash);
        screenshots.push({
          buffer: bestCandidate,
          description: `${feature.name} after interaction`,
          filename: `${feature.slug}-action-1.png`,
        });
        descriptions.push(`${feature.name} after interaction`);
        console.log(`[crawl] ✓ Action screenshot selected for ${feature.name} — ${candidateTier}, step ${stepCount}`);
      } else {
        console.log(`[crawl] ✗ Best candidate was a cross-feature duplicate for ${feature.name}`);
      }
    }
  } else {
    console.log(`[crawl] ✗ No valid action screenshot for ${feature.name} (hero only)`);
  }

  // ─── FORM SUBMISSION PASS ───
  // Only if the agent found a form AND we have fewer than 2 action screenshots
  if (understanding?.hasSubmittableForm && !understanding?.isReadOnly && screenshots.length < 2) {
    console.log(`[crawl] Attempting form submission for ${feature.name}...`);

    // Navigate back to clean state for a fresh form fill
    await navigateToFeature(page, stagehand, fullUrl, feature.name, appUrl);

    const submitTimeout = new AbortController();
    const submitTimer = setTimeout(() => submitTimeout.abort(), 45000);

    try {
      const submitAgent = stagehand.agent({
        model: "anthropic/claude-sonnet-4-6",
        systemPrompt: `You fill forms and submit them. Use realistic data:
- Names: Sarah Johnson, Alex Chen
- Emails: sarah@company.com
- Phone: +1 (415) 555-0192
- Dates: use near-future dates
- Titles: Q4 Planning Review
- Descriptions: Review quarterly objectives and align on priorities.
After clicking the submit button, wait 3 seconds for the result to appear.
NEVER click Delete, Remove, Send, Invite, Share, or Pay.`,
      });

      await submitAgent.execute({
        instruction: "Fill all form fields with realistic data, then click the Save/Submit/Create/Update button. If no safe button exists, do nothing.",
        maxSteps: 5,
        signal: submitTimeout.signal,
      });

      // Wait for the result to render
      await new Promise(r => setTimeout(r, 3000));

      // Capture result — only if we're still on a non-login, non-loading page with different content
      const resultBuffer = await takeScreenshot(page);
      const resultLoading = await isPageLoading(page);
      const resultAuth = isAuthPageUrl(page.url());
      const resultHash = hashScreenshot(resultBuffer);

      if (!resultLoading && !resultAuth &&
        isScreenshotDifferent(heroBuffer, resultBuffer) &&
        !globalScreenshotHashes.has(resultHash)) {
        globalScreenshotHashes.add(resultHash);
        screenshots.push({
          buffer: resultBuffer,
          description: `${feature.name} after form submission`,
          filename: `${feature.slug}-result-1.png`,
        });
        descriptions.push(`${feature.name} after form submission`);
        console.log(`[crawl] ✓ Form result screenshot captured for ${feature.name}`);
      }
    } catch {
      // Timeout or failure — we still have hero + potentially the monitoring screenshot
    } finally {
      clearTimeout(submitTimer);
    }
  }

  // ─── STORE SCREENSHOTS ───
  const screens: ScreenRecord[] = [];
  let orderIndex = startOrderIndex;

  for (const shot of screenshots) {
    const screenshotUrl = await uploadScreenshot(jobId, shot.buffer, shot.filename);
    if (!screenshotUrl) continue;

    const dom = await cleanDom(page);
    const record: ScreenRecord = {
      id: "",
      url: fullUrl, // Always use the FEATURE URL, not current page URL
      routePath: new URL(fullUrl).pathname,
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
  console.log(`[crawl] Feature "${feature.name}" complete: ${screens.length} action screenshots in ${elapsed}s`);

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
        waitUntil: "domcontentloaded",
        timeoutMs: PAGE_TIMEOUT_MS,
      });
      await waitForSettle(page);
    }

    // ----- Feature crawl -----
    const { features } = config;
    const featureUnderstandings: FeatureUnderstanding[] = [];
    const globalScreenshotHashes = new Set<string>();

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

            await navigateToFeature(page, stagehand, fullUrl, feature.name, config.appUrl);

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
                await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeoutMs: PAGE_TIMEOUT_MS });
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
              const heroHashBuffer = await takeScreenshot(page);
              globalScreenshotHashes.add(hashScreenshot(heroHashBuffer));
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
                globalScreenshotHashes,
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
                  await page.goto(subUrl, { waitUntil: "domcontentloaded", timeoutMs: PAGE_TIMEOUT_MS });
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
                      globalScreenshotHashes,
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
            await page.goto(config.appUrl, { waitUntil: "domcontentloaded", timeoutMs: 10000 });
          } catch {
            // Even navigation failed, but we continue
          }
        }
      }

      // Rate limit cooldown between features
      if (fi < features.length - 1) {
        const cooldown = isExternalApp(config.appUrl) ? 45000 : 15000;
        console.log(`[crawl] Rate limit cooldown: ${cooldown / 1000}s before next feature...`);
        await broadcastProgress(config.jobId, "info", "Preparing next feature...");
        await new Promise(r => setTimeout(r, cooldown));
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
