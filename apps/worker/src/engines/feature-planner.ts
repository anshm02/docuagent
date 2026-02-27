// ============================================================
// DocuAgent — Feature Planner (replaces Journey Planner)
// Selects which discovered features to document within budget.
// For small apps (<= maxFeatures), documents all.
// For large apps, prioritizes by sidebar order.
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

export function selectFeatures(
  discoveryResults: DiscoveryResult[],
  maxFeatures: number,
): FeatureSelectionResult {
  console.log("[feature-planner] Selecting features from discovery results...");
  console.log(`[feature-planner]   Discovery pages: ${discoveryResults.length}`);
  console.log(`[feature-planner]   Budget: max ${maxFeatures} features`);

  // Filter to only accessible, non-error, authenticated pages
  const candidates = discoveryResults
    .filter((r) => r.isAccessible && !r.hasError)
    .filter((r) => !shouldExcludeRoute(r.route));

  console.log(`[feature-planner]   Candidates after filtering: ${candidates.length}`);

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

  // Convert to Feature objects, using discovery order as priority (sidebar order)
  const allFeatures: Feature[] = candidates.map((r, idx) => {
    let name = "";

    // If pages share a generic site title, always use route-based names
    if (hasGenericTitle && r.pageTitle === mostCommonTitle[0]) {
      name = deriveNameFromRoute(r.route);
    } else {
      // Extract a clean feature name from the page title
      name = r.pageTitle || "";
      // Remove app name suffixes like "- Dashboard", "| Settings"
      name = name.replace(/\s*[-|–—]\s*.*$/, "").trim();
      // If page title is empty or generic, derive from route
      if (!name || name.toLowerCase() === "dashboard" || name.length > 40) {
        name = deriveNameFromRoute(r.route);
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
    };
  });

  // De-duplicate by slug
  const seenSlugs = new Set<string>();
  const uniqueFeatures: Feature[] = [];
  for (const f of allFeatures) {
    if (seenSlugs.has(f.slug)) continue;
    seenSlugs.add(f.slug);
    uniqueFeatures.push(f);
  }

  // Select top N features
  const selected = uniqueFeatures.slice(0, maxFeatures);
  const additional = uniqueFeatures.slice(maxFeatures).map((f) => ({
    title: f.name,
    description: f.description,
  }));

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
