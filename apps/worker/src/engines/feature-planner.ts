// ============================================================
// DocuAgent — Feature Planner (replaces Journey Planner)
// Selects which discovered features to document within budget.
// Includes pre-scan phase: visits each candidate page, takes a
// screenshot, and asks Claude to evaluate documentation value.
// ============================================================

import type { Stagehand, Page } from "@browserbasehq/stagehand";
import type {
  DiscoveryResult,
  Feature,
  FeatureSelectionResult,
  PageScanResult,
} from "@docuagent/shared";
import { MAX_PRESCAN_CANDIDATES } from "@docuagent/shared";
import { claudeVision, parseJsonResponse } from "../lib/claude.js";
import { waitForSettle } from "../lib/stagehand.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
}

// Patterns for pages that should NOT become feature documentation
const EXCLUDE_PATTERNS = [
  /^\/?$/, // root/landing page
  /\/(sign-in|signin|login|log-in)/i,
  /\/(sign-up|signup|register)/i,
  /\/(auth|oauth|callback)/i,
  /\/(pricing|plans)/i,
  /\/(error|404|500)/i,
  /\/(terms|privacy|legal)/i,
  /\/(verify|confirm|reset)/i,
];

function shouldExcludeRoute(route: string): boolean {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(route));
}

// ---------------------------------------------------------------------------
// Feature Scoring — prioritize core app pages over UI component showcases
// Used as a pre-filter BEFORE the Claude-powered pre-scan (to cap candidates)
// ---------------------------------------------------------------------------

function scoreFeature(route: string, pageTitle: string, hasForm: boolean, hasTable: boolean): number {
  let score = 0;
  const r = route.toLowerCase();
  const t = pageTitle.toLowerCase();

  // === HIGH VALUE: Core app pages ===
  if (r === "/" || r === "/dashboard" || /^\/dashboard\/?$/.test(r)) score += 100;
  if (r.includes("profile") || r.includes("account") || r.includes("settings")) score += 90;
  if (r.includes("team") || r.includes("member") || r.includes("user") || r.includes("people")) score += 85;
  if (r.includes("project") || r.includes("task") || r.includes("issue") || r.includes("ticket")) score += 80;
  if (r.includes("invoice") || r.includes("billing") || r.includes("payment") || r.includes("subscription")) score += 75;
  if (r.includes("calendar") || r.includes("schedule") || r.includes("event")) score += 70;
  if (r.includes("report") || r.includes("analytics") || r.includes("insight")) score += 65;
  if (r.includes("security") || r.includes("password") || r.includes("2fa")) score += 60;
  if (r.includes("activity") || r.includes("log") || r.includes("audit") || r.includes("history")) score += 55;
  if (r.includes("notification") || r.includes("alert") || r.includes("inbox")) score += 50;
  if (r.includes("contact") || r.includes("customer") || r.includes("client") || r.includes("lead")) score += 75;
  if (r.includes("order") || r.includes("product") || r.includes("inventory")) score += 70;
  if (r.includes("message") || r.includes("chat") || r.includes("conversation")) score += 65;
  if (r.includes("file") || r.includes("document") || r.includes("media")) score += 50;
  if (r.includes("integration") || r.includes("connect") || r.includes("api")) score += 45;
  if (r.includes("e-commerce") || r.includes("ecommerce")) score += 80;
  if (r.includes("table") || r.includes("data")) score += 40;
  if (r.includes("form")) score += 35;

  // === MEDIUM VALUE: Functional content ===
  if (hasForm) score += 30;
  if (hasTable) score += 20;

  // === LOW VALUE: Display/reference pages ===
  if (r.includes("chart") || r.includes("graph")) score += 10;

  // === NEGATIVE: Pages that should NOT be documented ===
  if (r.includes("blank") || r.includes("empty") || t.includes("blank") || t.includes("empty")) score = -200;
  if (r.includes("error") || r.includes("404") || r.includes("500") || r.includes("not-found")) score = -200;
  if (r.includes("sample") || r.includes("demo") || r.includes("example") || r.includes("test")) score -= 50;

  // UI component showcase pages (not end-user features)
  const componentPages = [
    "button", "badge", "avatar", "modal", "alert", "tooltip", "image",
    "video", "icon", "card", "tab", "breadcrumb", "pagination", "progress",
    "spinner", "divider", "ribbon",
  ];
  for (const comp of componentPages) {
    if (r.includes(comp) && !r.includes("setting") && !r.includes("manage")) score -= 30;
  }

  // Route depth bonus: top-level routes are more important
  const depth = route.split("/").filter(Boolean).length;
  if (depth <= 1) score += 15;
  if (depth === 2) score += 5;

  return score;
}

// ---------------------------------------------------------------------------
// Overlay dismissal (lightweight version for pre-scan — no stagehand.act)
// ---------------------------------------------------------------------------

async function dismissOverlaysForPrescan(page: Page, stagehand: Stagehand): Promise<void> {
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
      try {
        await stagehand.act(
          "Close any popup, banner, cookie notice, or overlay that is blocking the main content. Click the X button, Close button, Accept button, or Dismiss button.",
          { timeout: 5000 },
        );
      } catch {
        try {
          await stagehand.act("Press the Escape key", { timeout: 3000 });
        } catch { /* ignore */ }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {
    // Overlays are best-effort
  }
}

// ---------------------------------------------------------------------------
// Pre-scan: Visit each candidate page and ask Claude to evaluate it
// ---------------------------------------------------------------------------

const PRESCAN_PROMPT = `Look at this screenshot of a page at route "ROUTE_PLACEHOLDER" with title "TITLE_PLACEHOLDER".

Rate this page's DOCUMENTATION VALUE on a scale of 1-10:

10 = Core product feature with real functionality (task management, project views, team settings, dashboards with data, calendar with events, CRM contacts, forms that create/edit records)
8 = Important settings or configuration page (account settings, workspace settings, integrations, billing)
6 = Useful secondary feature (activity log, search results, file browser, notifications list WITH content)
4 = Reference or showcase page (component library, style guide, demo page with sample data)
2 = Empty state with no real content (inbox showing "No messages", empty task list with only "Create your first task" prompt, today view with no items)
1 = Onboarding/tutorial page ("Getting Started", "Welcome", "Tour"), marketing page, or error page

CRITICAL RULES:
- If the page is mostly empty with just a prompt to "create your first X", score it 2-3 max
- If the page title contains "Getting Started", "Welcome", "Tutorial", "Onboarding", "Tour", score it 1-2
- If the page is a notification inbox or message inbox that's empty, score it 1-2
- If the page shows "Today" or "Upcoming" with no items, score it 2
- If the page has real data, interactive elements, forms, tables with content, score it 7+
- If the page is a core workflow (creating issues, managing projects, team settings), score it 9-10
- The more UNIQUE and USEFUL content visible on the page, the higher the score
- Pages that look like they'd actually help a user learn the product = high score
- Pages that are just empty shells waiting for data = low score

Return ONLY valid JSON. No markdown, no explanation, no backticks.
{"score": 8, "reason": "Project management board with Kanban columns, filters, and real task cards - core product feature", "suggestedName": "Project Board", "pageType": "core_feature"}`;

export async function prescanPages(
  page: Page,
  stagehand: Stagehand,
  candidates: DiscoveryResult[],
  appUrl: string,
  onProgress?: (message: string) => Promise<void>,
): Promise<PageScanResult[]> {
  const results: PageScanResult[] = [];

  console.log(`[pre-scan] Starting pre-scan of ${candidates.length} candidate pages...`);

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      if (onProgress) {
        await onProgress(`Evaluating page ${i + 1}/${candidates.length}: ${candidate.pageTitle || candidate.route}...`);
      }

      // Navigate to the page
      const fullUrl = candidate.route.startsWith("http")
        ? candidate.route
        : new URL(candidate.route, appUrl).toString();
      await page.goto(fullUrl, { waitUntil: "networkidle", timeoutMs: 15000 }).catch(() => {
        // Timeout is OK, page may still be usable
      });
      await new Promise((r) => setTimeout(r, 2000)); // Let page render

      // Dismiss any overlays
      await dismissOverlaysForPrescan(page, stagehand);

      // Scroll to top
      await page.evaluate(() => (globalThis as any).window.scrollTo(0, 0));

      // Take a quick screenshot
      const screenshot = await page.screenshot({ type: "png" });
      const base64 = Buffer.from(screenshot).toString("base64");

      // Build the prompt with actual route and title
      const prompt = PRESCAN_PROMPT
        .replace("ROUTE_PLACEHOLDER", candidate.route)
        .replace("TITLE_PLACEHOLDER", candidate.pageTitle || "");

      // Ask Claude to evaluate
      const evaluation = await claudeVision(prompt, base64, {
        maxTokens: 200,
        temperature: 0,
        system: "You evaluate web application pages for documentation value. Return only JSON.",
      });

      const parsed = parseJsonResponse<{
        score: number;
        reason: string;
        suggestedName: string;
        pageType: string;
      }>(evaluation);

      const scanResult: PageScanResult = {
        route: candidate.route,
        pageTitle: candidate.pageTitle,
        documentationValue: parsed.score,
        reason: parsed.reason,
        suggestedName: parsed.suggestedName || candidate.pageTitle,
        pageType: (parsed.pageType || "other") as PageScanResult["pageType"],
      };
      results.push(scanResult);

      const statusEmoji = parsed.score >= 5 ? "+" : "-";
      console.log(`[pre-scan] [${statusEmoji}] ${candidate.route}: score=${parsed.score}/10 (${parsed.pageType}) — ${parsed.reason}`);

      if (onProgress) {
        const verdict = parsed.score >= 5 ? "worth documenting" : "skipping (not a core feature)";
        await onProgress(`${candidate.pageTitle || candidate.route}: ${verdict} (${parsed.score}/10)`);
      }

      // Rate limit protection
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      console.log(`[pre-scan] Failed to scan ${candidate.route}: ${err}`);
      // Default to medium score if scan fails — let the heuristic scoring decide
      results.push({
        route: candidate.route,
        pageTitle: candidate.pageTitle,
        documentationValue: 5,
        reason: "Scan failed, default score",
        suggestedName: candidate.pageTitle,
        pageType: "other",
      });
    }
  }

  // Summary
  const worthIt = results.filter((r) => r.documentationValue >= 5).length;
  const skipped = results.filter((r) => r.documentationValue < 5).length;
  console.log(`[pre-scan] Complete: ${worthIt} pages worth documenting, ${skipped} pages skipped`);

  return results;
}

// ---------------------------------------------------------------------------
// Title Cleaning — remove framework prefixes, app name suffixes, etc.
// Used as fallback when pre-scan doesn't provide a suggestedName.
// ---------------------------------------------------------------------------

function cleanPageTitle(rawTitle: string, appName: string): string {
  let title = rawTitle;

  // Step 1: Remove everything after the first separator
  const pipesSplit = title.split(/\s*[|–—]\s*/);
  if (pipesSplit.length > 1) {
    title = pipesSplit[0].trim();
  } else {
    const dashSplit = title.split(/\s+-\s+/);
    if (dashSplit.length > 1) {
      title = dashSplit[0].trim();
    }
  }

  // Step 2: Remove framework prefixes
  const prefixes = [
    "Next.js ", "NextJS ", "React ", "ReactJS ", "Vue ", "VueJS ",
    "Angular ", "Svelte ", "Nuxt ", "Remix ",
  ];
  for (const p of prefixes) {
    if (title.startsWith(p)) {
      title = title.slice(p.length).trim();
    }
  }

  // Step 3: Remove generic suffixes
  const suffixes = [" Page", " Template", " Component", " Demo", " Example", " View", " Screen"];
  for (const s of suffixes) {
    if (title.endsWith(s) && title.length > s.length + 2) {
      title = title.slice(0, -s.length).trim();
    }
  }

  // Step 4: Remove app name if it appears
  if (appName && appName.length > 1) {
    const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    title = title.replace(regex, "").trim();
    title = title.replace(/^[\s|–—-]+|[\s|–—-]+$/g, "").trim();
  }

  // Step 5: Clean leftover artifacts
  title = title.replace(/\s+/g, " ").trim();

  return title.length >= 2 ? title : "";
}

// ---------------------------------------------------------------------------
// Detect app name from page titles (e.g., "| TailAdmin" suffix)
// ---------------------------------------------------------------------------

function detectAppNameFromTitles(candidates: DiscoveryResult[]): string {
  const titles = candidates.map((r) => (r.pageTitle || "").trim()).filter(Boolean);
  if (titles.length < 2) return "";

  const suffixes: string[] = [];
  for (const t of titles) {
    const pipeMatch = t.match(/\s*[|–—]\s*(.+)$/);
    if (pipeMatch) {
      suffixes.push(pipeMatch[1].trim());
    } else {
      const dashMatch = t.match(/\s+-\s+(.+)$/);
      if (dashMatch) {
        suffixes.push(dashMatch[1].trim());
      }
    }
  }

  if (suffixes.length < 2) return "";

  const counts = new Map<string, number>();
  for (const s of suffixes) {
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted[0] && sorted[0][1] >= 2) {
    const fullSuffix = sorted[0][0];
    const dashParts = fullSuffix.split(/\s+-\s+/);
    return dashParts[0].trim();
  }

  return "";
}

// ---------------------------------------------------------------------------
// Get pre-scan candidates — filter and optionally cap by heuristic score
// ---------------------------------------------------------------------------

export function getPrescanCandidates(
  discoveryResults: DiscoveryResult[],
  postLoginRoute?: string,
): DiscoveryResult[] {
  const normalizedPostLoginRoute = postLoginRoute?.replace(/\/$/, "") || undefined;

  // Filter to accessible, non-error pages (same logic as selectFeatures)
  const candidates = discoveryResults
    .filter((r) => r.isAccessible && !r.hasError)
    .filter((r) => {
      const normalizedRoute = r.route.replace(/\/$/, "") || "/";
      if (normalizedPostLoginRoute && normalizedRoute === normalizedPostLoginRoute) return true;
      return !shouldExcludeRoute(r.route);
    });

  // If more than MAX_PRESCAN_CANDIDATES, use heuristic scoring to pick the top ones
  if (candidates.length > MAX_PRESCAN_CANDIDATES) {
    console.log(`[feature-planner] ${candidates.length} candidates exceeds max ${MAX_PRESCAN_CANDIDATES}, using heuristic pre-filter`);
    const scored = candidates.map((c) => ({
      candidate: c,
      score: scoreFeature(c.route, c.pageTitle || "", c.hasForm, c.hasTable),
    }));
    scored.sort((a, b) => b.score - a.score);
    const capped = scored.slice(0, MAX_PRESCAN_CANDIDATES).map((s) => s.candidate);
    console.log(`[feature-planner] Pre-filter selected top ${capped.length} by heuristic score`);
    return capped;
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Main feature selection — now uses pre-scan results when available
// ---------------------------------------------------------------------------

export function selectFeatures(
  discoveryResults: DiscoveryResult[],
  maxFeatures: number,
  postLoginRoute?: string,
  preScanResults?: PageScanResult[],
): FeatureSelectionResult {
  console.log("[feature-planner] Selecting features from discovery results...");
  console.log(`[feature-planner]   Discovery pages: ${discoveryResults.length}`);
  console.log(`[feature-planner]   Budget: max ${maxFeatures} features`);
  if (preScanResults) {
    console.log(`[feature-planner]   Pre-scan results available: ${preScanResults.length} pages scored`);
  }

  const normalizedPostLoginRoute = postLoginRoute?.replace(/\/$/, "") || undefined;

  // Filter to only accessible, non-error, authenticated pages
  const candidates = discoveryResults
    .filter((r) => r.isAccessible && !r.hasError)
    .filter((r) => {
      const normalizedRoute = r.route.replace(/\/$/, "") || "/";
      if (normalizedPostLoginRoute && normalizedRoute === normalizedPostLoginRoute) return true;
      return !shouldExcludeRoute(r.route);
    });

  console.log(`[feature-planner]   Candidates after filtering: ${candidates.length}`);

  // Build pre-scan lookup
  const scanLookup = new Map<string, PageScanResult>();
  if (preScanResults) {
    for (const sr of preScanResults) {
      scanLookup.set(sr.route, sr);
    }
  }

  // If we have pre-scan results, filter by documentation value FIRST
  let filteredCandidates = candidates;
  if (preScanResults && preScanResults.length > 0) {
    const worthDocumenting: DiscoveryResult[] = [];
    const excluded: { route: string; score: number; reason: string }[] = [];

    for (const c of candidates) {
      const scan = scanLookup.get(c.route);
      if (!scan) {
        // Not pre-scanned (wasn't in top candidates) — include if heuristic score is OK
        const heuristicScore = scoreFeature(c.route, c.pageTitle || "", c.hasForm, c.hasTable);
        if (heuristicScore >= 0) {
          worthDocumenting.push(c);
        }
        continue;
      }
      if (scan.documentationValue >= 5) {
        worthDocumenting.push(c);
      } else {
        excluded.push({ route: c.route, score: scan.documentationValue, reason: scan.reason });
      }
    }

    // Log exclusions
    if (excluded.length > 0) {
      console.log(`[feature-planner]   Pre-scan EXCLUDED ${excluded.length} low-value pages:`);
      for (const e of excluded) {
        console.log(`[feature-planner]     EXCLUDED: ${e.route} (score=${e.score}) — ${e.reason}`);
      }
    }

    // Sort worth-documenting by pre-scan score (highest first)
    worthDocumenting.sort((a, b) => {
      const scanA = scanLookup.get(a.route);
      const scanB = scanLookup.get(b.route);
      const scoreA = scanA?.documentationValue ?? 5;
      const scoreB = scanB?.documentationValue ?? 5;
      return scoreB - scoreA;
    });

    filteredCandidates = worthDocumenting;
    console.log(`[feature-planner]   After pre-scan filter: ${filteredCandidates.length} pages worth documenting`);
  }

  // Detect app name from page titles for title cleaning (fallback)
  const detectedAppName = detectAppNameFromTitles(filteredCandidates);
  if (detectedAppName) {
    console.log(`[feature-planner]   Detected app name from titles: "${detectedAppName}"`);
  }

  // Detect if most pages share the same title (generic site title)
  const titleCounts = new Map<string, number>();
  for (const r of filteredCandidates) {
    const t = (r.pageTitle || "").trim();
    titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
  }
  const mostCommonTitle = [...titleCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const hasGenericTitle = mostCommonTitle && mostCommonTitle[1] > 1;

  function deriveNameFromRoute(route: string): string {
    const cleaned = route
      .replace(/^\/?(dashboard\/?)?/, "")
      .split("/")[0]
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
    return cleaned || "Dashboard";
  }

  // Convert to Feature objects with scores
  const scoredFeatures: (Feature & { score: number })[] = filteredCandidates.map((r, idx) => {
    const scan = scanLookup.get(r.route);
    let name = "";

    // Prefer Claude's suggested name from pre-scan
    if (scan?.suggestedName && scan.suggestedName.length >= 2 && scan.suggestedName.length <= 50) {
      name = scan.suggestedName;
    } else if (hasGenericTitle && r.pageTitle === mostCommonTitle[0]) {
      // Fallback: route-based names for generic titles
      name = deriveNameFromRoute(r.route);
    } else {
      // Fallback: clean the page title
      const cleaned = cleanPageTitle(r.pageTitle || "", detectedAppName);
      if (cleaned && cleaned.length >= 2 && cleaned.toLowerCase() !== "dashboard" && cleaned.length <= 40) {
        name = cleaned;
      } else {
        name = deriveNameFromRoute(r.route);
      }
    }

    // Use pre-scan score if available, otherwise fall back to heuristic
    let score: number;
    if (scan) {
      // Map pre-scan value (1-10) to a comparable range
      // Pre-scan 10 → 200, Pre-scan 5 → 100, Pre-scan 1 → 20
      score = scan.documentationValue * 20;
    } else {
      score = scoreFeature(r.route, r.pageTitle || "", r.hasForm, r.hasTable);
    }

    // Post-login landing page gets highest priority
    if (postLoginRoute) {
      const normalizedRoute = r.route.replace(/\/$/, "") || "/";
      const normalizedPostLogin = postLoginRoute.replace(/\/$/, "") || "/";
      if (normalizedRoute === normalizedPostLogin) {
        score += 200;
        console.log(`[feature-planner]   Homepage boost (+200) for ${r.route} (matches post-login URL)`);
      }
    }

    return {
      id: `feature-${idx + 1}`,
      name,
      slug: slugify(name),
      description: `${name} feature page`,
      route: r.route,
      hasForm: r.hasForm,
      priority: idx + 1,
      score,
    };
  });

  // Sort by score descending
  scoredFeatures.sort((a, b) => b.score - a.score);

  // Log all scores for debugging
  console.log("[feature-planner]   Feature scores:");
  for (const f of scoredFeatures) {
    const scan = scanLookup.get(f.route);
    const scanInfo = scan ? ` [pre-scan: ${scan.documentationValue}/10 ${scan.pageType}]` : " [heuristic]";
    console.log(`[feature-planner]     score=${f.score.toString().padStart(4)} | ${f.name} (${f.route})${scanInfo}`);
  }

  // Filter out features with score < 0 entirely (not even in "additional")
  const viable = scoredFeatures.filter((f) => f.score >= 0);

  // De-duplicate by slug
  const seenSlugs = new Set<string>();
  const uniqueFeatures: (Feature & { score: number })[] = [];
  for (const f of viable) {
    if (seenSlugs.has(f.slug)) continue;
    seenSlugs.add(f.slug);
    uniqueFeatures.push(f);
  }

  // --- Group features by parent category ---
  const parentGroups = new Map<string, (Feature & { score: number })[]>();
  const ungrouped: (Feature & { score: number })[] = [];

  const routeToParent = new Map<string, string>();
  for (const dr of discoveryResults) {
    if (dr.parentCategory) {
      routeToParent.set(dr.route, dr.parentCategory);
    }
  }

  for (const f of uniqueFeatures) {
    const parent = routeToParent.get(f.route);
    if (parent) {
      if (!parentGroups.has(parent)) parentGroups.set(parent, []);
      parentGroups.get(parent)!.push(f);
    } else {
      ungrouped.push(f);
    }
  }

  // Merge grouped features
  const mergedFeatures: (Feature & { score: number })[] = [];
  for (const [parent, children] of parentGroups) {
    if (children.length > 1) {
      const bestScore = Math.max(...children.map((c) => c.score));
      const allHaveForms = children.some((c) => c.hasForm);
      const parentSlug = slugify(parent);
      const subPages = children.map((c) => ({ name: c.name, route: c.route }));

      console.log(`[feature-planner]   Grouping "${parent}" with ${children.length} sub-pages: ${children.map((c) => c.name).join(", ")}`);

      mergedFeatures.push({
        id: `feature-group-${parentSlug}`,
        name: parent,
        slug: parentSlug,
        description: `${parent} feature with ${children.length} sections`,
        route: children[0].route,
        hasForm: allHaveForms,
        priority: 0,
        score: bestScore + 10,
        subPages,
      });
    } else {
      ungrouped.push(...children);
    }
  }

  // Combine merged groups with ungrouped, sort by score
  const allFeatures = [...mergedFeatures, ...ungrouped];
  allFeatures.sort((a, b) => b.score - a.score);

  // Select top N features
  const selected: Feature[] = allFeatures.slice(0, maxFeatures).map(({ score: _score, ...rest }) => rest);
  const additionalFromAll = allFeatures.slice(maxFeatures);
  const additional = additionalFromAll.map((f) => ({
    title: f.name,
    description: f.description,
  }));

  // Re-assign priority based on final order
  for (let i = 0; i < selected.length; i++) {
    selected[i].priority = i + 1;
  }

  console.log(`[feature-planner]   Selected ${selected.length} features:`);
  for (const f of selected) {
    console.log(`[feature-planner]     ${f.priority}. ${f.name} (${f.route}) ${f.hasForm ? "[has form]" : ""}`);
  }
  if (additional.length > 0) {
    console.log(`[feature-planner]   Additional features available with upgrade: ${additional.length}`);
    for (const a of additional) {
      console.log(`[feature-planner]     - ${a.title}`);
    }
  }

  return { selected, additional };
}
