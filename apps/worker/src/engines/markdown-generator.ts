// ============================================================
// DocuAgent — Markdown Documentation Generator (Feature-based)
// Generates one .md file per feature + index.md + .zip
// ============================================================

import { getSupabase } from "../lib/supabase.js";
import { claudeText, parseJsonResponse } from "../lib/claude.js";
import { featureProsePrompt } from "../prompts/feature-prose.js";
import { overviewPrompt } from "../prompts/cross-cutting.js";
import type {
  Screen,
  ScreenAnalysis,
  Feature,
  PRDSummary,
  FeaturePageContent,
} from "@docuagent/shared";
import type { AppUnderstanding } from "./crawl.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarkdownGenConfig {
  jobId: string;
  appName: string;
  appUrl: string;
  prdSummary: PRDSummary | null;
  features: Feature[];
  appUnderstanding?: AppUnderstanding;
}

export interface MarkdownGenResult {
  docsUrl: string;
  zipUrl: string;
  totalScreens: number;
  screenshotCount: number;
  sections: string[];
  avgConfidence: number;
  durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
}

function getScreenshotType(filename: string): string {
  if (filename.includes("-form-filled") || filename.includes("-filled"))
    return "form-filled";
  if (filename.includes("-modal-open")) return "modal-open";
  if (filename.includes("-tab-")) return "tab";
  if (filename.includes("-result")) return "result";
  if (filename.includes("-scrolled")) return "scrolled";
  if (filename.includes("-expanded")) return "expanded";
  if (filename.includes("-tooltip")) return "tooltip";
  return "hero";
}

async function fetchScreenshotBuffer(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      console.log(
        `[md-gen] Got HTML instead of image for ${url}, retrying after 3s...`,
      );
      await new Promise((r) => setTimeout(r, 3000));
      const retry = await fetch(url);
      if (!retry.ok) return null;
      const retryType = retry.headers.get("content-type") ?? "";
      if (retryType.includes("text/html")) return null;
      const buf = await retry.arrayBuffer();
      return Buffer.from(buf);
    }
    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    console.error(`[md-gen] Failed to fetch screenshot: ${url}`, err);
    return null;
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

// ---------------------------------------------------------------------------
// AI Content Generation
// ---------------------------------------------------------------------------

async function generateFeaturePageContent(
  feature: Feature,
  screens: Screen[],
  prdSummary: PRDSummary | null,
  otherFeatures: { name: string; slug: string }[],
  screenshotFilenames: Map<string, string>,
  appUnderstanding?: AppUnderstanding,
): Promise<FeaturePageContent> {
  const screenAnalyses = screens
    .filter((s) => s.analysis)
    .map((s) => {
      const ref = `screen_${s.order_index}`;
      const filename = screenshotFilenames.get(ref) ?? `${ref}.png`;
      const screenshotType = getScreenshotType(filename);
      return {
        screenshotType,
        analysis: s.analysis as ScreenAnalysis,
        screenshotRef: filename,
      };
    });

  if (screenAnalyses.length === 0) {
    return {
      title: feature.name,
      slug: slugify(feature.name),
      intro: feature.description,
      action_groups: [
        {
          heading: feature.name,
          steps: [{ action: "Follow the on-screen instructions." }],
        },
      ],
      permission_notes: [],
      fields: [],
      hero_screenshot_ref: "",
    };
  }

  // Collect code context from hero screen
  const heroScreen = screens.find(
    (s) => s.nav_path && !s.nav_path.includes("("),
  );
  const codeContext = heroScreen?.code_context ?? null;

  // Build enriched context from app understanding
  const featureUnderstanding = appUnderstanding?.features.find(
    (f) => f.slug === feature.slug || f.name === feature.name,
  );

  const prompt = featureProsePrompt({
    featureName: feature.name,
    featureSlug: feature.slug,
    screenAnalyses,
    otherFeatures,
    prdSummary,
    codeContext,
    featureUnderstanding: featureUnderstanding
      ? {
          purpose: featureUnderstanding.purpose,
          userGoals: featureUnderstanding.userGoals,
          connectedFeatures: featureUnderstanding.connectedFeatures,
        }
      : undefined,
  });

  try {
    const raw = await claudeText(prompt, { maxTokens: 4000, temperature: 0 });
    const parsed = parseJsonResponse<{
      title: string;
      intro: string;
      hero_screenshot_ref?: string;
      action_groups: {
        heading: string;
        steps: { action: string; detail?: string }[];
        screenshot_ref?: string | null;
        outcome?: string;
      }[];
      permission_notes?: string[];
      fields?: {
        label: string;
        type: string;
        required: boolean;
        description: string;
      }[];
      tips?: string[];
    }>(raw);

    return {
      title: parsed.title || feature.name,
      slug: slugify(parsed.title || feature.name),
      intro: parsed.intro,
      action_groups: (parsed.action_groups ?? []).map((ag) => ({
        ...ag,
        screenshot_ref: ag.screenshot_ref ?? undefined,
      })),
      permission_notes: parsed.permission_notes ?? [],
      fields: parsed.fields ?? [],
      hero_screenshot_ref:
        parsed.hero_screenshot_ref ??
        screenAnalyses[0]?.screenshotRef ??
        "",
      tips: parsed.tips ?? [],
    };
  } catch (err) {
    console.error(
      `[md-gen] Feature prose generation failed for "${feature.name}":`,
      err,
    );
    return {
      title: feature.name,
      slug: slugify(feature.name),
      intro: feature.description,
      action_groups: screenAnalyses.map((sa) => ({
        heading: sa.analysis.page_title,
        steps: sa.analysis.actions.map((a) => ({ action: a.description })),
      })),
      permission_notes: [],
      fields: screenAnalyses.flatMap((sa) => sa.analysis.fields),
      hero_screenshot_ref: screenAnalyses[0]?.screenshotRef ?? "",
    };
  }
}

async function generateOverview(
  appName: string,
  appUrl: string,
  features: { name: string; slug: string; description: string }[],
  prdSummary: PRDSummary | null,
): Promise<{
  overview: string;
  featureDescriptions: Map<string, string>;
}> {
  const prompt = overviewPrompt({
    appName,
    appUrl,
    featureList: features,
    prdSummary,
  });

  try {
    const raw = await claudeText(prompt, { maxTokens: 1500, temperature: 0 });
    const parsed = parseJsonResponse<{
      product_overview: string;
      feature_descriptions?: Record<string, string>;
    }>(raw);
    return {
      overview: parsed.product_overview,
      featureDescriptions: new Map(
        Object.entries(parsed.feature_descriptions ?? {}),
      ),
    };
  } catch (err) {
    console.error("[md-gen] Overview generation failed:", err);
    return {
      overview: `${appName} is a web application that helps teams manage their workflow.`,
      featureDescriptions: new Map(),
    };
  }
}

// ---------------------------------------------------------------------------
// Editorial Review Pass (Part E)
// ---------------------------------------------------------------------------

async function reviewAndRefineDocumentation(
  allDocs: { slug: string; title: string; markdown: string }[],
  appName: string,
): Promise<Map<string, string>> {
  const allContent = allDocs
    .map((d) => `=== ${d.title} (${d.slug}.md) ===\n${d.markdown}`)
    .join("\n\n");

  const reviewPrompt = `You are a senior technical writing editor reviewing documentation for ${appName}.

Read ALL the documentation pages below, then return improved versions that fix these issues:

1. REMOVE REPETITION: If two pages explain the same concept (e.g., what the Owner role means), keep it on the most relevant page and remove it from the other. Add a brief cross-reference instead.

2. CONSISTENT VOICE: Ensure all pages use the same terminology and tone. Use "click" for buttons, "enter" for text fields, "select" for dropdowns consistently across ALL pages.

3. KILL REMAINING FILLER: If any section just describes basic UI navigation (sidebar, dark mode, search bar), remove it entirely.

4. STRENGTHEN WEAK INTROS: If any page intro describes WHAT the feature is instead of WHY it matters, rewrite it. Every intro should answer "why would I care about this?"

5. ADD MISSING CROSS-REFERENCES: If Feature A creates something that appears in Feature B, mention that connection. "Changes you make here are recorded in the Activity Log."

6. VERIFY SCREENSHOT REFERENCES: Every image reference should match a real screenshot. Don't invent image references that don't exist in the provided content.

7. TIGHTEN STEPS: If any step is longer than one line, shorten it. If any action group has more than 5 steps, split it or remove unnecessary steps.

8. CONTEXTUAL TIPS ONLY: Remove any generic tips like "use a strong password" or "check your spam folder." Only keep tips that are specific to THIS app and THIS feature.

HERE IS ALL THE DOCUMENTATION:

${allContent}

Return a JSON object where keys are slugs and values are the improved markdown content:
{ "team-management": "# Team Management\\n\\nimproved content...", "general-settings": "..." }

Only return pages that you CHANGED. If a page is already good, omit it from the response.

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;

  try {
    const raw = await claudeText(reviewPrompt, {
      maxTokens: 8000,
      temperature: 0,
    });
    const improvements = parseJsonResponse<Record<string, string>>(raw);
    return new Map(Object.entries(improvements));
  } catch (err) {
    console.error("[md-gen] Review pass failed:", err);
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Markdown File Builders
// ---------------------------------------------------------------------------

function buildFeatureMarkdown(
  content: FeaturePageContent,
  screenshotFilenames: Map<string, string>,
): string {
  const lines: string[] = [];

  // Title
  lines.push(`# ${content.title}`);
  lines.push("");

  // Intro
  lines.push(content.intro);
  lines.push("");

  // Hero screenshot
  const heroFilename = content.hero_screenshot_ref;
  // Check if this filename exists in our map (by value), or use directly
  const heroExists =
    heroFilename &&
    (Array.from(screenshotFilenames.values()).includes(heroFilename) ||
      screenshotFilenames.has(content.hero_screenshot_ref));
  if (heroExists && heroFilename) {
    lines.push(`![${content.title}](./images/${heroFilename})`);
    lines.push("");
  }

  // Track used screenshot filenames to avoid duplicates
  const usedScreenshots = new Set<string>();
  if (heroFilename) usedScreenshots.add(heroFilename);

  // Action groups
  for (const group of content.action_groups) {
    lines.push(`## ${group.heading}`);
    lines.push("");

    for (let i = 0; i < group.steps.length; i++) {
      const step = group.steps[i];
      lines.push(`${i + 1}. ${step.action}`);
      if (step.detail) {
        lines.push(`   ${step.detail}`);
      }
    }
    lines.push("");

    // Action group screenshot (after steps, before outcome)
    if (group.screenshot_ref) {
      const filename = group.screenshot_ref;
      if (filename && !usedScreenshots.has(filename)) {
        const fileExists =
          Array.from(screenshotFilenames.values()).includes(filename) ||
          screenshotFilenames.has(filename);
        if (fileExists) {
          lines.push(`![${group.heading}](./images/${filename})`);
          lines.push("");
          usedScreenshots.add(filename);
        }
      }
    }

    // Outcome sentence
    if (group.outcome) {
      lines.push(group.outcome);
      lines.push("");
    }
  }

  // Permission notes
  if (content.permission_notes.length > 0) {
    for (const note of content.permission_notes) {
      lines.push(`> ${note}`);
      lines.push("");
    }
  }

  // Field table
  if (content.fields.length > 0) {
    lines.push("## Fields");
    lines.push("");
    lines.push("| Field | Type | Required | Description |");
    lines.push("|-------|------|----------|-------------|");
    for (const field of content.fields) {
      const req = field.required ? "Yes" : "No";
      const desc = field.description.replace(/\|/g, "\\|");
      lines.push(`| ${field.label} | ${field.type} | ${req} | ${desc} |`);
    }
    lines.push("");
  }

  // Tips
  if (content.tips && content.tips.length > 0) {
    for (const tip of content.tips) {
      lines.push(`> **Tip:** ${tip}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function buildIndexMarkdown(
  appName: string,
  appUrl: string,
  overview: string,
  features: { title: string; slug: string; description: string }[],
): string {
  const lines: string[] = [];

  lines.push(`# ${appName} Documentation`);
  lines.push("");
  lines.push(overview);
  lines.push("");
  lines.push("## Getting Started");
  lines.push("");
  lines.push(
    `1. Go to [${appUrl}](${appUrl}) and create an account.`,
  );
  lines.push("2. Sign in to access your dashboard.");
  lines.push("3. Use the sidebar to navigate between features.");
  lines.push("");
  lines.push("## Features");
  lines.push("");
  for (const f of features) {
    lines.push(`- [${f.title}](./${f.slug}.md) — ${f.description}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    `*Generated by DocuAgent on ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}*`,
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Zip creation
// ---------------------------------------------------------------------------

function createZipBuffer(
  files: { path: string; content: Buffer }[],
): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const pathBuf = Buffer.from(file.path, "utf8");
    const content = file.content;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc32(content), 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(pathBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localEntry = Buffer.concat([localHeader, pathBuf, content]);
    localHeaders.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc32(content), 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(pathBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralHeaders.push(Buffer.concat([centralHeader, pathBuf]));
    offset += localEntry.length;
  }

  const centralDir = Buffer.concat(centralHeaders);
  const centralDirOffset = offset;

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDir.length, 12);
  endRecord.writeUInt32LE(centralDirOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, centralDir, endRecord]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

// ---------------------------------------------------------------------------
// Upload to Supabase Storage
// ---------------------------------------------------------------------------

async function ensureBucket(bucketName: string): Promise<void> {
  const supabase = getSupabase();
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === bucketName);
  if (!exists) {
    await supabase.storage.createBucket(bucketName, { public: true });
  }
}

async function uploadFile(
  bucketName: string,
  path: string,
  content: Buffer | string,
  contentType: string,
): Promise<string> {
  const supabase = getSupabase();
  const buffer =
    typeof content === "string" ? Buffer.from(content, "utf8") : content;

  const { error } = await supabase.storage
    .from(bucketName)
    .upload(path, buffer, { contentType, upsert: true });

  if (error) {
    await ensureBucket(bucketName);
    const { error: retryErr } = await supabase.storage
      .from(bucketName)
      .upload(path, buffer, { contentType, upsert: true });
    if (retryErr) throw new Error(`Upload failed: ${retryErr.message}`);
  }

  const { data: urlData } = supabase.storage
    .from(bucketName)
    .getPublicUrl(path);
  return urlData.publicUrl;
}

// ---------------------------------------------------------------------------
// Main: Generate markdown documentation
// ---------------------------------------------------------------------------

export async function runMarkdownGenerator(
  config: MarkdownGenConfig,
): Promise<MarkdownGenResult> {
  const startTime = Date.now();
  const supabase = getSupabase();
  const sections: string[] = [];
  let screenshotCount = 0;
  const basePath = `docs/${config.jobId}`;

  console.log("[md-gen] Starting markdown documentation generation...");
  await broadcastProgress(
    config.jobId,
    "Generating markdown documentation...",
  );

  // ----- Fetch all analyzed screens -----
  const { data: allScreens, error: fetchErr } = await supabase
    .from("screens")
    .select("*")
    .eq("job_id", config.jobId)
    .in("status", ["analyzed", "crawled"])
    .order("order_index");

  if (fetchErr)
    throw new Error(`Failed to fetch screens: ${fetchErr.message}`);
  const screens = (allScreens ?? []) as Screen[];
  const analyzedScreens = screens.filter((s) => s.analysis);

  console.log(
    `[md-gen] ${screens.length} screens total, ${analyzedScreens.length} analyzed`,
  );

  // ----- Fetch + upload screenshots to images/ with descriptive names -----
  console.log("[md-gen] Fetching screenshots...");
  const screenshotFilenames = new Map<string, string>();
  const imageFiles: { path: string; content: Buffer }[] = [];

  await Promise.all(
    screens.map(async (screen) => {
      if (!screen.screenshot_url) return;
      const buf = await fetchScreenshotBuffer(screen.screenshot_url);
      if (!buf) return;

      const ref = `screen_${screen.order_index}`;
      let filename: string;
      try {
        const urlPath = new URL(screen.screenshot_url).pathname;
        const parts = urlPath.split("/");
        filename = parts[parts.length - 1] || `${ref}.png`;
      } catch {
        filename = `${ref}.png`;
      }

      screenshotFilenames.set(ref, filename);
      screenshotCount++;

      await uploadFile(
        "documents",
        `${basePath}/images/${filename}`,
        buf,
        "image/png",
      );
      imageFiles.push({ path: `docs/images/${filename}`, content: buf });
    }),
  );
  console.log(`[md-gen] Uploaded ${screenshotCount} screenshots`);

  // ----- AI Content Generation -----
  console.log("[md-gen] Generating AI content...");
  await broadcastProgress(
    config.jobId,
    "Generating documentation content with AI...",
  );

  // Group screens by feature
  const featureMap = new Map<string, Screen[]>();
  for (const screen of analyzedScreens) {
    const fid = screen.journey_id ?? "unknown";
    if (!featureMap.has(fid)) featureMap.set(fid, []);
    featureMap.get(fid)!.push(screen);
  }

  // Build other-features list for cross-references
  const allFeatureRefs = config.features.map((f) => ({
    name: f.name,
    slug: f.slug,
  }));

  // Generate feature page content
  const featureContents: {
    content: FeaturePageContent;
    feature: Feature;
    markdown: string;
  }[] = [];
  const mdFiles: { path: string; content: Buffer }[] = [];

  for (const feature of config.features) {
    const fScreens = featureMap.get(feature.id) ?? [];
    if (fScreens.length === 0) {
      console.log(
        `[md-gen] No analyzed screens for feature: ${feature.name}, skipping`,
      );
      continue;
    }

    console.log(
      `[md-gen] Generating markdown for feature: ${feature.name} (${fScreens.length} screens)`,
    );
    await broadcastProgress(
      config.jobId,
      `Writing feature page: ${feature.name}`,
    );

    // Pass other features (excluding self) for cross-references
    const otherFeatures = allFeatureRefs.filter(
      (f) => f.slug !== feature.slug,
    );

    const content = await generateFeaturePageContent(
      feature,
      fScreens,
      config.prdSummary,
      otherFeatures,
      screenshotFilenames,
      config.appUnderstanding,
    );

    // Build feature markdown
    const md = buildFeatureMarkdown(content, screenshotFilenames);
    featureContents.push({ content, feature, markdown: md });
    sections.push(`Feature: ${content.title}`);
  }

  // ----- Editorial Review Pass (Part E) -----
  console.log("[md-gen] Running editorial review pass...");
  await broadcastProgress(config.jobId, "Running editorial review...");

  const docsForReview = featureContents.map((fc) => ({
    slug: fc.feature.slug,
    title: fc.content.title,
    markdown: fc.markdown,
  }));

  const improvements = await reviewAndRefineDocumentation(
    docsForReview,
    config.appName,
  );

  // Apply improvements
  for (const [slug, improvedContent] of improvements) {
    const existing = featureContents.find((fc) => fc.feature.slug === slug);
    if (existing) {
      existing.markdown = improvedContent;
      console.log(`[md-gen] Refined: ${slug}.md`);
    }
  }

  // Upload feature markdown files (after review)
  for (const fc of featureContents) {
    const featurePath = `${basePath}/${fc.feature.slug}.md`;
    await uploadFile("documents", featurePath, fc.markdown, "text/markdown");
    mdFiles.push({
      path: `docs/${fc.feature.slug}.md`,
      content: Buffer.from(fc.markdown, "utf8"),
    });
  }

  // Generate overview content for index.md
  console.log("[md-gen] Generating overview...");
  await broadcastProgress(config.jobId, "Writing overview...");

  const featureList = featureContents.map(({ content, feature }) => ({
    name: content.title,
    slug: feature.slug,
    description: feature.description,
  }));

  const { overview, featureDescriptions } = await generateOverview(
    config.appName,
    config.appUrl,
    featureList,
    config.prdSummary,
  );

  // Index (table of contents) — use AI-generated feature descriptions if available
  const indexFeatures = featureContents.map(({ content, feature }) => {
    const aiDesc = featureDescriptions.get(feature.slug);
    return {
      title: content.title,
      slug: feature.slug,
      description: aiDesc || content.intro.split(".")[0] + ".",
    };
  });

  const indexMd = buildIndexMarkdown(
    config.appName,
    config.appUrl,
    overview,
    indexFeatures,
  );
  await uploadFile(
    "documents",
    `${basePath}/index.md`,
    indexMd,
    "text/markdown",
  );
  mdFiles.push({
    path: "docs/index.md",
    content: Buffer.from(indexMd, "utf8"),
  });
  sections.push("Index");

  // ----- Generate and upload .zip -----
  console.log("[md-gen] Creating .zip archive...");
  await broadcastProgress(config.jobId, "Creating downloadable archive...");

  const allZipFiles = [...mdFiles, ...imageFiles];
  const zipBuffer = createZipBuffer(allZipFiles);
  const zipPath = `${basePath}/documentation.zip`;
  const zipUrl = await uploadFile(
    "documents",
    zipPath,
    zipBuffer,
    "application/zip",
  );

  console.log(
    `[md-gen] Zip created: ${(zipBuffer.length / 1024).toFixed(1)} KB`,
  );

  // ----- Calculate stats -----
  const avgConfidence =
    analyzedScreens.length > 0
      ? analyzedScreens.reduce((sum, s) => sum + (s.confidence ?? 0), 0) /
        analyzedScreens.length
      : 0;

  const { data: urlData } = supabase.storage
    .from("documents")
    .getPublicUrl(`${basePath}/index.md`);
  const docsUrl = urlData.publicUrl;

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  console.log(`\n[md-gen] === Markdown Documentation Complete ===`);
  console.log(`[md-gen] Sections: ${sections.length}`);
  console.log(`[md-gen] Screenshots: ${screenshotCount}`);
  console.log(`[md-gen] Feature pages: ${featureContents.length}`);
  console.log(
    `[md-gen] Review refined: ${improvements.size} page(s)`,
  );
  console.log(
    `[md-gen] Zip size: ${(zipBuffer.length / 1024).toFixed(1)} KB`,
  );
  console.log(`[md-gen] Duration: ${durationSeconds}s`);

  return {
    docsUrl,
    zipUrl,
    totalScreens: analyzedScreens.length,
    screenshotCount,
    sections,
    avgConfidence: Math.round(avgConfidence * 10) / 10,
    durationSeconds,
  };
}
