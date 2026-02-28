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

async function extractNavLinks(page: Page, appUrl: string): Promise<string[]> {
  try {
    // Wait for page to settle and render navigation
    await waitForSettle(page);
    await new Promise((r) => setTimeout(r, 2000));

    const links = await page.evaluate(() => {
      const d = (globalThis as any).document;
      const results: { href: string; text: string }[] = [];

      // Strategy 1: Look for nav/sidebar links (common patterns)
      const navSelectors = [
        "nav a", "[role='navigation'] a", "aside a",
        ".sidebar a", ".nav a", "[class*='sidebar'] a", "[class*='nav'] a",
        "[class*='menu'] a", "[class*='Sidebar'] a", "[class*='Nav'] a",
      ];
      const navAnchors = d.querySelectorAll(navSelectors.join(", "));
      navAnchors.forEach((el: any) => {
        const href = el.getAttribute("href");
        const text = el.innerText?.trim();
        if (href && text && text.length > 0 && text.length < 50) {
          results.push({ href, text });
        }
      });

      // Strategy 2: If no nav links found, grab all internal <a> links from body
      if (results.length === 0) {
        const allAnchors = d.querySelectorAll("a[href]");
        allAnchors.forEach((el: any) => {
          const href = el.getAttribute("href");
          const text = el.innerText?.trim();
          if (
            href &&
            text &&
            text.length > 0 &&
            text.length < 50 &&
            !href.startsWith("http") &&
            !href.startsWith("#") &&
            !href.startsWith("javascript:") &&
            !href.startsWith("mailto:")
          ) {
            results.push({ href, text });
          }
        });
      }

      return results.map((r) => r.href);
    }) as string[];

    console.log(`[discovery] Raw nav links found: ${links.length}`);

    // Normalize and deduplicate
    const baseHost = new URL(appUrl).host;
    const seen = new Set<string>();
    const unique: string[] = [];
    // Skip auth-related paths
    const skipPatterns = ["/sign-in", "/sign-up", "/login", "/register", "/auth", "/forgot", "/reset"];

    for (const href of links) {
      let path: string;
      try {
        const u = new URL(href, appUrl);
        if (u.host !== baseHost) continue; // skip external links
        path = u.pathname;
      } catch {
        path = href;
      }
      // Skip root, auth paths, and very short paths
      if (path === "/" || path === "") continue;
      if (skipPatterns.some((p) => path.toLowerCase().includes(p))) continue;
      if (!seen.has(path)) {
        seen.add(path);
        unique.push(path);
      }
    }
    return unique;
  } catch (err) {
    console.error("[discovery] Failed to extract nav links:", err);
    return [];
  }
}

async function extractNavHierarchy(
  page: Page,
): Promise<{ parent: string; child: string; href: string }[]> {
  try {
    const structure = await page.evaluate(() => {
      const d = (globalThis as any).document;
      const results: { parent: string; child: string; href: string }[] = [];

      // Look for nested nav patterns: <li> with sub-<ul>, expandable sections
      const navSections = d.querySelectorAll(
        "nav li, aside li, [class*='sidebar'] li, [class*='Sidebar'] li, [class*='nav'] > div",
      );

      navSections.forEach((section: any) => {
        const subLinks = section.querySelectorAll(
          "ul a, div[class*='sub'] a, [class*='dropdown'] a, [class*='Dropdown'] a",
        );
        if (subLinks.length > 0) {
          // This section has children — extract parent text from the first non-link text element
          const parentEl = section.querySelector(
            ":scope > button, :scope > span, :scope > a, :scope > p, :scope > div > span, :scope > div > button",
          );
          const parentText = parentEl?.innerText?.trim() || "";
          if (!parentText) return;

          subLinks.forEach((link: any) => {
            const href = link.getAttribute("href");
            const text = link.innerText?.trim();
            if (href && text && parentText && text !== parentText) {
              results.push({ parent: parentText, child: text, href });
            }
          });
        }
      });

      return results;
    }) as { parent: string; child: string; href: string }[];

    return structure;
  } catch (err) {
    console.error("[discovery] Failed to extract nav hierarchy:", err);
    return [];
  }
}

export async function runDiscoveryCrawl(config: DiscoveryCrawlConfig): Promise<DiscoveryResult[]> {
  const { jobId, page, appUrl, crawlPlan } = config;
  const results: DiscoveryResult[] = [];

  let routePaths: string[];

  if (crawlPlan.routes.length > 0) {
    routePaths = crawlPlan.routes.map((r) => r.path);
    console.log(`[discovery] Discovering ${routePaths.length} routes from code analysis...`);
    await broadcastProgress(jobId, `Discovering ${routePaths.length} routes from code analysis...`);
  } else {
    // Fallback: extract nav links from the current page (already authenticated)
    console.log("[discovery] No code analysis routes, extracting nav links from current page...");
    await broadcastProgress(jobId, "No code analysis — discovering features from app navigation...");
    routePaths = await extractNavLinks(page, appUrl);
    console.log(`[discovery] Found ${routePaths.length} nav links: ${routePaths.join(", ")}`);
    if (routePaths.length === 0) {
      console.log("[discovery] No nav links found on current page");
      return results;
    }
    await broadcastProgress(jobId, `Found ${routePaths.length} navigation links to explore`);
  }

  // Extract sidebar hierarchy to detect parent-child grouping
  const navHierarchy = await extractNavHierarchy(page);
  if (navHierarchy.length > 0) {
    console.log(`[discovery] Detected ${navHierarchy.length} parent-child nav relationships`);
    for (const h of navHierarchy) {
      console.log(`[discovery]   "${h.parent}" → "${h.child}" (${h.href})`);
    }
  }

  // Build a map of route → parent category
  const routeToParent = new Map<string, string>();
  const baseHost = new URL(appUrl).host;
  for (const h of navHierarchy) {
    try {
      const u = new URL(h.href, appUrl);
      if (u.host === baseHost) {
        routeToParent.set(u.pathname, h.parent);
      }
    } catch {
      routeToParent.set(h.href, h.parent);
    }
  }

  for (let i = 0; i < routePaths.length; i++) {
    const routePath = routePaths[i];
    console.log(`[discovery] [${i + 1}/${routePaths.length}] Visiting: ${routePath}`);

    const result = await discoverRoute(page, jobId, appUrl, routePath);

    // Attach parent category from nav hierarchy
    const parentCategory = routeToParent.get(routePath);
    if (parentCategory) {
      result.parentCategory = parentCategory;
    }

    results.push(result);

    const status = result.isAccessible
      ? `accessible${result.hasForm ? ", has form" : ""}${result.hasTable ? ", has table" : ""}${parentCategory ? ` [parent: ${parentCategory}]` : ""}`
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
