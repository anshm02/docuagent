// ============================================================
// DocuAgent — Discovery Crawl Engine (V2)
// Visits each route from code analysis quickly, no AI calls.
// Captures: URL, title, accessibility, form/table presence, nav elements
// ============================================================

import { Page } from "@browserbasehq/stagehand";
import { getSupabase } from "../lib/supabase.js";
import { takeScreenshot, waitForSettle } from "../lib/stagehand.js";
import type { CrawlPlan, DiscoveryResult } from "@docuagent/shared";
import { DISCOVERY_TIMEOUT_MS } from "@docuagent/shared";

export interface DiscoveryCrawlConfig {
  jobId: string;
  page: Page;
  appUrl: string;
  crawlPlan: CrawlPlan;
}

async function uploadDiscoveryScreenshot(
  jobId: string,
  buffer: Buffer,
  routePath: string,
): Promise<string> {
  try {
    const supabase = getSupabase();
    const safeName = routePath.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_");
    const path = `screenshots/${jobId}/discovery_${safeName}_${Date.now()}.png`;
    const { error } = await supabase.storage
      .from("screenshots")
      .upload(path, buffer, { contentType: "image/png", upsert: true });
    if (error) {
      console.error(`[discovery] Upload failed for ${routePath}:`, error.message);
      return "";
    }
    const { data } = supabase.storage.from("screenshots").getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.error(`[discovery] Upload exception for ${routePath}:`, err);
    return "";
  }
}

async function broadcastProgress(
  jobId: string,
  message: string,
): Promise<void> {
  try {
    const supabase = getSupabase();
    await supabase.from("progress_messages").insert({
      job_id: jobId,
      type: "info",
      message,
    });
  } catch {
    // non-critical
  }
}

async function discoverRoute(
  page: Page,
  jobId: string,
  appUrl: string,
  routePath: string,
): Promise<DiscoveryResult> {
  const fullUrl = routePath.startsWith("http")
    ? routePath
    : `${appUrl.replace(/\/$/, "")}${routePath}`;

  const result: DiscoveryResult = {
    route: routePath,
    actualUrl: fullUrl,
    pageTitle: "",
    isAccessible: false,
    hasForm: false,
    hasTable: false,
    hasError: false,
    navElements: [],
    screenshotUrl: "",
  };

  try {
    await page.goto(fullUrl, {
      waitUntil: "domcontentloaded",
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
    await waitForSettle(page);

    result.actualUrl = page.url();

    // Extract page info via page.evaluate (no AI calls)
    // Note: the callback runs in browser context where `document` exists
    const pageInfo = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const d = (globalThis as any).document;
      const title = d.title || "";
      const hasForms = d.querySelectorAll("form, input, textarea, select").length > 0;
      const hasTables = d.querySelectorAll("table, [role='grid'], [role='table']").length > 0;

      const bodyText = (d.body as any)?.innerText?.toLowerCase() ?? "";
      const hasErrorIndicator =
        bodyText.includes("404") ||
        bodyText.includes("not found") ||
        bodyText.includes("error") ||
        bodyText.includes("something went wrong") ||
        bodyText.includes("access denied") ||
        bodyText.includes("forbidden");

      const is404 =
        title.toLowerCase().includes("404") ||
        title.toLowerCase().includes("not found");

      const navLinks: string[] = [];
      const navEls = d.querySelectorAll(
        "nav a, [role='navigation'] a, aside a, .sidebar a, .nav a"
      );
      navEls.forEach((el: any) => {
        const text = el.innerText?.trim();
        if (text && text.length < 50 && !navLinks.includes(text)) {
          navLinks.push(text);
        }
      });

      return {
        title,
        hasForms,
        hasTables,
        hasError: is404 || (hasErrorIndicator && !hasForms && !hasTables),
        navLinks: navLinks.slice(0, 20),
      };
    }) as { title: string; hasForms: boolean; hasTables: boolean; hasError: boolean; navLinks: string[] };

    result.pageTitle = pageInfo.title;
    result.isAccessible = !pageInfo.hasError;
    result.hasForm = pageInfo.hasForms;
    result.hasTable = pageInfo.hasTables;
    result.hasError = pageInfo.hasError;
    result.navElements = pageInfo.navLinks;

    // Take a quick screenshot
    const screenshotBuffer = await takeScreenshot(page);
    result.screenshotUrl = await uploadDiscoveryScreenshot(jobId, screenshotBuffer, routePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[discovery] Failed to visit ${routePath}: ${msg}`);
    result.hasError = true;
    result.isAccessible = false;
  }

  return result;
}

export async function runDiscoveryCrawl(config: DiscoveryCrawlConfig): Promise<DiscoveryResult[]> {
  const { jobId, page, appUrl, crawlPlan } = config;
  const results: DiscoveryResult[] = [];

  if (crawlPlan.routes.length === 0) {
    console.log("[discovery] No routes from code analysis, skipping discovery");
    await broadcastProgress(jobId, "No routes to discover — will use browser navigation fallback");
    return results;
  }

  console.log(`[discovery] Discovering ${crawlPlan.routes.length} routes...`);
  await broadcastProgress(jobId, `Discovering ${crawlPlan.routes.length} routes from code analysis...`);

  for (let i = 0; i < crawlPlan.routes.length; i++) {
    const route = crawlPlan.routes[i];
    console.log(`[discovery] [${i + 1}/${crawlPlan.routes.length}] Visiting: ${route.path}`);

    const result = await discoverRoute(page, jobId, appUrl, route.path);
    results.push(result);

    const status = result.isAccessible
      ? `accessible${result.hasForm ? ", has form" : ""}${result.hasTable ? ", has table" : ""}`
      : result.hasError
        ? "ERROR"
        : "inaccessible";
    console.log(`[discovery]   → ${status} | "${result.pageTitle}"`);
  }

  const accessible = results.filter((r) => r.isAccessible).length;
  const errors = results.filter((r) => r.hasError).length;
  console.log(`[discovery] Discovery complete: ${accessible} accessible, ${errors} errors out of ${results.length} routes`);

  return results;
}
