// ============================================================
// DocuAgent — Feature Planner (replaces Journey Planner)
// Selects which discovered features to document within budget.
// For small apps (<= maxFeatures), documents all.
// For large apps, prioritizes by scoring.
// ============================================================

import type { DiscoveryResult, Feature, FeatureSelectionResult } from "@docuagent/shared";

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
// Title Cleaning — remove framework prefixes, app name suffixes, etc.
// ---------------------------------------------------------------------------

function cleanPageTitle(rawTitle: string, appName: string): string {
  let title = rawTitle;

  // Step 1: Remove everything after the first separator
  // "Next.js Bar Chart | TailAdmin - Dashboard Template" → "Next.js Bar Chart"
  const pipesSplit = title.split(/\s*[|–—]\s*/);
  if (pipesSplit.length > 1) {
    title = pipesSplit[0].trim();
  } else {
    // Also handle " - " as separator if no | found
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

  // Step 3: Remove generic suffixes only if title would still be meaningful
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
  // Look for a common suffix pattern like "| AppName" or "- AppName"
  const titles = candidates.map((r) => (r.pageTitle || "").trim()).filter(Boolean);
  if (titles.length < 2) return "";

  // Find common suffix after | or -
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

  // Find the most common suffix
  const counts = new Map<string, number>();
  for (const s of suffixes) {
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted[0] && sorted[0][1] >= 2) {
    // Extract just the first "word" of the suffix as app name
    // e.g. "TailAdmin - Next.js Dashboard Template" → "TailAdmin"
    const fullSuffix = sorted[0][0];
    const dashParts = fullSuffix.split(/\s+-\s+/);
    return dashParts[0].trim();
  }

  return "";
}

export function selectFeatures(
  discoveryResults: DiscoveryResult[],
  maxFeatures: number,
  postLoginRoute?: string,
): FeatureSelectionResult {
  console.log("[feature-planner] Selecting features from discovery results...");
  console.log(`[feature-planner]   Discovery pages: ${discoveryResults.length}`);
  console.log(`[feature-planner]   Budget: max ${maxFeatures} features`);

  // Normalize post-login route for comparison
  const normalizedPostLoginRoute = postLoginRoute?.replace(/\/$/, "") || undefined;

  // Filter to only accessible, non-error, authenticated pages
  // Exception: the post-login landing page is never excluded
  const candidates = discoveryResults
    .filter((r) => r.isAccessible && !r.hasError)
    .filter((r) => {
      const normalizedRoute = r.route.replace(/\/$/, "") || "/";
      if (normalizedPostLoginRoute && normalizedRoute === normalizedPostLoginRoute) return true;
      return !shouldExcludeRoute(r.route);
    });

  console.log(`[feature-planner]   Candidates after filtering: ${candidates.length}`);

  // Detect app name from page titles for title cleaning
  const detectedAppName = detectAppNameFromTitles(candidates);
  if (detectedAppName) {
    console.log(`[feature-planner]   Detected app name from titles: "${detectedAppName}"`);
  }

  // Detect if most pages share the same title (generic site title)
  const titleCounts = new Map<string, number>();
  for (const r of candidates) {
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
  const scoredFeatures: (Feature & { score: number })[] = candidates.map((r, idx) => {
    let name = "";

    // If pages share a generic site title, always use route-based names
    if (hasGenericTitle && r.pageTitle === mostCommonTitle[0]) {
      name = deriveNameFromRoute(r.route);
    } else {
      // Clean the page title first
      const cleaned = cleanPageTitle(r.pageTitle || "", detectedAppName);
      if (cleaned && cleaned.length >= 2 && cleaned.toLowerCase() !== "dashboard" && cleaned.length <= 40) {
        name = cleaned;
      } else {
        name = deriveNameFromRoute(r.route);
      }
    }

    let score = scoreFeature(r.route, r.pageTitle || "", r.hasForm, r.hasTable);

    // Post-login landing page gets highest priority — every user sees it first
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
    console.log(`[feature-planner]     score=${f.score.toString().padStart(4)} | ${f.name} (${f.route})`);
  }

  // Filter out features with score < -50 entirely (not even in "additional")
  const viable = scoredFeatures.filter((f) => f.score >= -50);
  const excluded = scoredFeatures.filter((f) => f.score < -50);
  if (excluded.length > 0) {
    console.log(`[feature-planner]   Excluded ${excluded.length} low-value pages:`);
    for (const f of excluded) {
      console.log(`[feature-planner]     score=${f.score} | ${f.name} (${f.route})`);
    }
  }

  // De-duplicate by slug
  const seenSlugs = new Set<string>();
  const uniqueFeatures: (Feature & { score: number })[] = [];
  for (const f of viable) {
    if (seenSlugs.has(f.slug)) continue;
    seenSlugs.add(f.slug);
    uniqueFeatures.push(f);
  }

  // --- Group features by parent category ---
  // If multiple routes share the same parentCategory, merge them into ONE feature with subPages
  const parentGroups = new Map<string, (Feature & { score: number })[]>();
  const ungrouped: (Feature & { score: number })[] = [];

  // Build parentCategory lookup from discoveryResults
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
      // Multiple children → group as one feature with subPages
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
        route: children[0].route, // primary route = first child
        hasForm: allHaveForms,
        priority: 0,
        score: bestScore + 10, // Slight boost for grouped features (more content)
        subPages,
      });
    } else {
      // Single child with a parent — keep as-is (no grouping needed)
      ungrouped.push(...children);
    }
  }

  // Combine merged groups with ungrouped, sort by score
  const allFeatures = [...mergedFeatures, ...ungrouped];
  allFeatures.sort((a, b) => b.score - a.score);

  // Select top N features with score >= 0
  const selectable = allFeatures.filter((f) => f.score >= 0);
  const lowScore = allFeatures.filter((f) => f.score < 0 && f.score >= -50);

  const selected: Feature[] = selectable.slice(0, maxFeatures).map(({ score: _score, ...rest }) => rest);
  const additionalFromSelectable = selectable.slice(maxFeatures);
  const additional = [...additionalFromSelectable, ...lowScore].map((f) => ({
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
