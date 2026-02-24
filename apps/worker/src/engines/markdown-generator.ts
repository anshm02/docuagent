// ============================================================
// DocuAgent — Markdown Documentation Generator (Stage 7 V2)
// Replaces .docx with a folder of .md files + images + .zip
// ============================================================

import { getSupabase } from "../lib/supabase.js";
import { claudeText, parseJsonResponse } from "../lib/claude.js";
import { journeyProsePrompt } from "../prompts/journey-prose.js";
import { crossCuttingPrompt, productOverviewPrompt } from "../prompts/cross-cutting.js";
import type {
  Screen,
  ScreenAnalysis,
  Journey,
  PRDSummary,
  MarkdownJourneyContent,
  MarkdownCrossCutting,
} from "@docuagent/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarkdownGenConfig {
  jobId: string;
  appName: string;
  prdSummary: PRDSummary | null;
  journeys: Journey[];
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

interface ScreenWithImage {
  screen: Screen;
  imageBuffer: Buffer | null;
  imageFilename: string;
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

async function fetchScreenshotBuffer(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    console.error(`[md-gen] Failed to fetch screenshot: ${url}`, err);
    return null;
  }
}

async function broadcastProgress(jobId: string, message: string): Promise<void> {
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

async function generateJourneyMarkdown(
  journeyTitle: string,
  journeyDescription: string,
  screens: Screen[],
  prdSummary: PRDSummary | null,
): Promise<MarkdownJourneyContent> {
  const screenAnalyses = screens
    .filter((s) => s.analysis)
    .map((s, idx) => ({
      stepNum: s.journey_step ?? idx,
      navPath: s.nav_path ?? "",
      analysis: s.analysis as ScreenAnalysis,
      screenshotRef: `screen_${s.order_index}`,
      codeContext: s.code_context,
    }));

  if (screenAnalyses.length === 0) {
    return {
      title: journeyTitle,
      slug: slugify(journeyTitle),
      intro: journeyDescription,
      how_to_get_there: "Navigate using the sidebar menu.",
      steps: [{ action: "Follow the on-screen instructions." }],
      permission_notes: [],
      fields: [],
      tips: [],
      related: [],
      hero_screenshot_ref: "",
      step_screenshot_refs: [],
    };
  }

  const prompt = journeyProsePrompt({
    journeyTitle,
    journeyDescription,
    screenAnalyses,
    prdSummary: prdSummary
      ? {
          product_purpose: prdSummary.product_purpose,
          main_features: prdSummary.main_features,
          user_roles: prdSummary.user_roles,
        }
      : null,
  });

  try {
    const raw = await claudeText(prompt, { maxTokens: 4000, temperature: 0 });
    const parsed = parseJsonResponse<{
      title: string;
      intro: string;
      how_to_get_there: string;
      steps: { action: string; detail?: string }[];
      permission_notes?: string[];
      fields?: { label: string; type: string; required: boolean; description: string }[];
      tips?: string[];
      related_slugs?: string[];
    }>(raw);

    return {
      title: parsed.title || journeyTitle,
      slug: slugify(parsed.title || journeyTitle),
      intro: parsed.intro,
      how_to_get_there: parsed.how_to_get_there,
      steps: parsed.steps,
      permission_notes: parsed.permission_notes ?? [],
      fields: parsed.fields ?? [],
      tips: parsed.tips ?? [],
      related: (parsed.related_slugs ?? []).map((slug) => ({ title: slug, slug })),
      hero_screenshot_ref: screenAnalyses[0]?.screenshotRef ?? "",
      step_screenshot_refs: screenAnalyses.map((sa) => sa.screenshotRef),
    };
  } catch (err) {
    console.error(`[md-gen] Journey prose generation failed for "${journeyTitle}":`, err);
    return {
      title: journeyTitle,
      slug: slugify(journeyTitle),
      intro: journeyDescription,
      how_to_get_there: screenAnalyses[0]?.analysis.navigation_path ?? "Use the sidebar navigation.",
      steps: screenAnalyses.map((sa) => ({
        action: sa.analysis.page_title,
        detail: sa.analysis.purpose,
      })),
      permission_notes: [],
      fields: screenAnalyses.flatMap((sa) => sa.analysis.fields),
      tips: screenAnalyses.flatMap((sa) => sa.analysis.tips).slice(0, 3),
      related: [],
      hero_screenshot_ref: screenAnalyses[0]?.screenshotRef ?? "",
      step_screenshot_refs: screenAnalyses.map((sa) => sa.screenshotRef),
    };
  }
}

async function generateCrossCutting(
  appName: string,
  screens: Screen[],
  prdSummary: PRDSummary | null,
): Promise<MarkdownCrossCutting> {
  const screenIndex = screens
    .filter((s) => s.analysis)
    .map((s) => {
      const analysis = s.analysis as ScreenAnalysis;
      return {
        pageTitle: analysis.page_title,
        purpose: analysis.purpose,
        navigationPath: analysis.navigation_path,
      };
    });

  const prompt = crossCuttingPrompt({ appName, screenIndex, prdSummary });

  try {
    const raw = await claudeText(prompt, { maxTokens: 3000, temperature: 0 });
    return parseJsonResponse<MarkdownCrossCutting>(raw);
  } catch (err) {
    console.error("[md-gen] Cross-cutting content generation failed:", err);
    return {
      quick_start_steps: [
        `Log in to **${appName}**.`,
        "Explore the main dashboard.",
        "Navigate using the sidebar.",
        "Create your first item.",
        "Configure your settings.",
      ],
      navigation_description: `${appName} uses a sidebar for primary navigation. The main content area displays the selected section.`,
      glossary: [],
      product_overview: `${appName} is a web application that helps teams manage their workflow.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Markdown File Builders
// ---------------------------------------------------------------------------

function buildJourneyMarkdown(
  content: MarkdownJourneyContent,
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
  const heroFilename = screenshotFilenames.get(content.hero_screenshot_ref);
  if (heroFilename) {
    lines.push(`![${content.title}](./images/${heroFilename})`);
    lines.push("");
  }

  // How to get there
  lines.push("## How to get there");
  lines.push("");
  lines.push(content.how_to_get_there);
  lines.push("");

  // Steps
  lines.push("## Steps");
  lines.push("");
  for (let i = 0; i < content.steps.length; i++) {
    const step = content.steps[i];
    lines.push(`${i + 1}. ${step.action}`);
    if (step.detail) {
      lines.push(`   ${step.detail}`);
    }
    // Insert screenshot after step if available
    const stepRef = content.step_screenshot_refs[i];
    if (stepRef) {
      const filename = screenshotFilenames.get(stepRef);
      if (filename && stepRef !== content.hero_screenshot_ref) {
        lines.push("");
        lines.push(`   ![Step ${i + 1}](./images/${filename})`);
      }
    }
  }
  lines.push("");

  // Permission notes
  if (content.permission_notes.length > 0) {
    for (const note of content.permission_notes) {
      lines.push(`> **Note:** ${note}`);
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
  if (content.tips.length > 0) {
    lines.push("## Tips");
    lines.push("");
    for (const tip of content.tips) {
      lines.push(`- ${tip}`);
    }
    lines.push("");
  }

  // Related links
  if (content.related.length > 0) {
    lines.push("## Related");
    lines.push("");
    for (const rel of content.related) {
      lines.push(`- [${rel.title}](./${rel.slug}.md)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildIndexMarkdown(
  appName: string,
  overview: string,
  journeys: { title: string; slug: string }[],
  hasGlossary: boolean,
): string {
  const lines: string[] = [];

  lines.push(`# ${appName} Documentation`);
  lines.push("");
  lines.push(overview);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Contents");
  lines.push("");
  lines.push("- [Quick Start](./quick-start.md)");
  lines.push("- [Navigation](./navigation.md)");
  lines.push("");
  lines.push("### Guides");
  lines.push("");
  for (const j of journeys) {
    lines.push(`- [${j.title}](./${j.slug}.md)`);
  }
  lines.push("");
  if (hasGlossary) {
    lines.push("### Reference");
    lines.push("");
    lines.push("- [Glossary](./glossary.md)");
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(`*Generated by DocuAgent on ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}*`);
  lines.push("");

  return lines.join("\n");
}

function buildQuickStartMarkdown(appName: string, steps: string[]): string {
  const lines: string[] = [];

  lines.push(`# Quick Start`);
  lines.push("");
  lines.push(`Get up and running with **${appName}** in five steps.`);
  lines.push("");
  for (let i = 0; i < steps.length; i++) {
    lines.push(`${i + 1}. ${steps[i]}`);
  }
  lines.push("");

  return lines.join("\n");
}

function buildNavigationMarkdown(description: string): string {
  const lines: string[] = [];

  lines.push("# Navigation");
  lines.push("");
  lines.push(description);
  lines.push("");

  return lines.join("\n");
}

function buildGlossaryMarkdown(
  glossary: { term: string; definition: string }[],
): string {
  const lines: string[] = [];

  lines.push("# Glossary");
  lines.push("");
  const sorted = [...glossary].sort((a, b) => a.term.localeCompare(b.term));
  for (const entry of sorted) {
    lines.push(`**${entry.term}**`);
    lines.push(`${entry.definition}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Zip creation (simple tar-like buffer — stores files as concatenated entries)
// We use a minimal approach: upload individual files + create a simple zip
// ---------------------------------------------------------------------------

// Minimal ZIP file creation without external dependencies
function createZipBuffer(
  files: { path: string; content: Buffer }[],
): Buffer {
  // Simple ZIP format implementation
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const pathBuf = Buffer.from(file.path, "utf8");
    const content = file.content;

    // Local file header (30 bytes + path + content)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Version needed
    localHeader.writeUInt16LE(0, 6); // General purpose bit flag
    localHeader.writeUInt16LE(0, 8); // Compression method (0 = stored)
    localHeader.writeUInt16LE(0, 10); // Last mod file time
    localHeader.writeUInt16LE(0, 12); // Last mod file date
    localHeader.writeUInt32LE(crc32(content), 14); // CRC-32
    localHeader.writeUInt32LE(content.length, 18); // Compressed size
    localHeader.writeUInt32LE(content.length, 22); // Uncompressed size
    localHeader.writeUInt16LE(pathBuf.length, 26); // File name length
    localHeader.writeUInt16LE(0, 28); // Extra field length

    const localEntry = Buffer.concat([localHeader, pathBuf, content]);
    localHeaders.push(localEntry);

    // Central directory header (46 bytes + path)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory header signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed
    centralHeader.writeUInt16LE(0, 8); // General purpose bit flag
    centralHeader.writeUInt16LE(0, 10); // Compression method
    centralHeader.writeUInt16LE(0, 12); // Last mod file time
    centralHeader.writeUInt16LE(0, 14); // Last mod file date
    centralHeader.writeUInt32LE(crc32(content), 16); // CRC-32
    centralHeader.writeUInt32LE(content.length, 20); // Compressed size
    centralHeader.writeUInt32LE(content.length, 24); // Uncompressed size
    centralHeader.writeUInt16LE(pathBuf.length, 28); // File name length
    centralHeader.writeUInt16LE(0, 30); // Extra field length
    centralHeader.writeUInt16LE(0, 32); // File comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes
    centralHeader.writeUInt32LE(0, 38); // External file attributes
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header

    centralHeaders.push(Buffer.concat([centralHeader, pathBuf]));
    offset += localEntry.length;
  }

  const centralDir = Buffer.concat(centralHeaders);
  const centralDirOffset = offset;

  // End of central directory record (22 bytes)
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  endRecord.writeUInt16LE(0, 4); // Number of this disk
  endRecord.writeUInt16LE(0, 6); // Disk where central directory starts
  endRecord.writeUInt16LE(files.length, 8); // Number of central directory records on this disk
  endRecord.writeUInt16LE(files.length, 10); // Total number of central directory records
  endRecord.writeUInt32LE(centralDir.length, 12); // Size of central directory
  endRecord.writeUInt32LE(centralDirOffset, 16); // Offset of start of central directory
  endRecord.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localHeaders, centralDir, endRecord]);
}

// CRC-32 implementation
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
  const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;

  const { error } = await supabase.storage
    .from(bucketName)
    .upload(path, buffer, { contentType, upsert: true });

  if (error) {
    // Try creating bucket and retry
    await ensureBucket(bucketName);
    const { error: retryErr } = await supabase.storage
      .from(bucketName)
      .upload(path, buffer, { contentType, upsert: true });
    if (retryErr) throw new Error(`Upload failed: ${retryErr.message}`);
  }

  const { data: urlData } = supabase.storage.from(bucketName).getPublicUrl(path);
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
  await broadcastProgress(config.jobId, "Generating markdown documentation...");

  // ----- Fetch all analyzed screens -----
  const { data: allScreens, error: fetchErr } = await supabase
    .from("screens")
    .select("*")
    .eq("job_id", config.jobId)
    .in("status", ["analyzed", "crawled"])
    .order("order_index");

  if (fetchErr) throw new Error(`Failed to fetch screens: ${fetchErr.message}`);
  const screens = (allScreens ?? []) as Screen[];
  const analyzedScreens = screens.filter((s) => s.analysis);

  console.log(`[md-gen] ${screens.length} screens total, ${analyzedScreens.length} analyzed`);

  // ----- Fetch + upload screenshots to images/ -----
  console.log("[md-gen] Fetching screenshots...");
  const screenshotFilenames = new Map<string, string>();
  const imageFiles: { path: string; content: Buffer }[] = [];

  await Promise.all(
    screens.map(async (screen) => {
      if (!screen.screenshot_url) return;
      const buf = await fetchScreenshotBuffer(screen.screenshot_url);
      if (!buf) return;

      const ref = `screen_${screen.order_index}`;
      const filename = `${ref}.png`;
      screenshotFilenames.set(ref, filename);
      screenshotCount++;

      // Upload to Supabase
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
  await broadcastProgress(config.jobId, "Generating documentation content with AI...");

  // Group screens by journey
  const journeyMap = new Map<string, Screen[]>();
  for (const screen of analyzedScreens) {
    const jid = screen.journey_id ?? "unknown";
    if (!journeyMap.has(jid)) journeyMap.set(jid, []);
    journeyMap.get(jid)!.push(screen);
  }

  // Build journey info
  const journeyInfos: { id: string; title: string; description: string }[] = [];
  if (config.journeys && config.journeys.length > 0) {
    for (const j of config.journeys) {
      journeyInfos.push({ id: j.id, title: j.title, description: j.description });
    }
  } else {
    for (const [jid, jScreens] of journeyMap) {
      const firstAnalysis = jScreens[0]?.analysis as ScreenAnalysis | null;
      journeyInfos.push({
        id: jid,
        title: firstAnalysis?.page_title ?? `Journey: ${jid}`,
        description: "Application workflow",
      });
    }
  }

  // Generate journey content
  const journeyContents: MarkdownJourneyContent[] = [];
  const mdFiles: { path: string; content: Buffer }[] = [];

  for (const jInfo of journeyInfos) {
    const jScreens = journeyMap.get(jInfo.id) ?? [];
    if (jScreens.length === 0) continue;

    console.log(`[md-gen] Generating markdown for journey: ${jInfo.title} (${jScreens.length} screens)`);
    await broadcastProgress(config.jobId, `Writing guide: ${jInfo.title}`);

    const content = await generateJourneyMarkdown(
      jInfo.title,
      jInfo.description,
      jScreens,
      config.prdSummary,
    );
    journeyContents.push(content);

    // Build and upload journey .md
    const md = buildJourneyMarkdown(content, screenshotFilenames);
    const journeyPath = `${basePath}/${content.slug}.md`;
    await uploadFile("documents", journeyPath, md, "text/markdown");
    mdFiles.push({ path: `docs/${content.slug}.md`, content: Buffer.from(md, "utf8") });
    sections.push(`Journey: ${content.title}`);
  }

  // Generate cross-cutting content
  console.log("[md-gen] Generating cross-cutting content...");
  await broadcastProgress(config.jobId, "Writing quick start and navigation guides...");

  const crossCutting = await generateCrossCutting(
    config.appName,
    analyzedScreens,
    config.prdSummary,
  );

  // Quick Start
  const quickStartMd = buildQuickStartMarkdown(config.appName, crossCutting.quick_start_steps);
  await uploadFile("documents", `${basePath}/quick-start.md`, quickStartMd, "text/markdown");
  mdFiles.push({ path: "docs/quick-start.md", content: Buffer.from(quickStartMd, "utf8") });
  sections.push("Quick Start");

  // Navigation
  const navMd = buildNavigationMarkdown(crossCutting.navigation_description);
  await uploadFile("documents", `${basePath}/navigation.md`, navMd, "text/markdown");
  mdFiles.push({ path: "docs/navigation.md", content: Buffer.from(navMd, "utf8") });
  sections.push("Navigation");

  // Glossary (only if terms exist)
  const hasGlossary = crossCutting.glossary.length > 0;
  if (hasGlossary) {
    const glossaryMd = buildGlossaryMarkdown(crossCutting.glossary);
    await uploadFile("documents", `${basePath}/glossary.md`, glossaryMd, "text/markdown");
    mdFiles.push({ path: "docs/glossary.md", content: Buffer.from(glossaryMd, "utf8") });
    sections.push("Glossary");
  }

  // Index (table of contents)
  const indexMd = buildIndexMarkdown(
    config.appName,
    crossCutting.product_overview,
    journeyContents.map((j) => ({ title: j.title, slug: j.slug })),
    hasGlossary,
  );
  await uploadFile("documents", `${basePath}/index.md`, indexMd, "text/markdown");
  mdFiles.push({ path: "docs/index.md", content: Buffer.from(indexMd, "utf8") });
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

  console.log(`[md-gen] Zip created: ${(zipBuffer.length / 1024).toFixed(1)} KB`);

  // ----- Calculate stats -----
  const avgConfidence = analyzedScreens.length > 0
    ? analyzedScreens.reduce((sum, s) => sum + (s.confidence ?? 0), 0) / analyzedScreens.length
    : 0;

  const { data: urlData } = supabase.storage
    .from("documents")
    .getPublicUrl(`${basePath}/index.md`);
  const docsUrl = urlData.publicUrl;

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  console.log(`\n[md-gen] === Markdown Documentation Complete ===`);
  console.log(`[md-gen] Sections: ${sections.length}`);
  console.log(`[md-gen] Screenshots: ${screenshotCount}`);
  console.log(`[md-gen] Journey guides: ${journeyContents.length}`);
  console.log(`[md-gen] Zip size: ${(zipBuffer.length / 1024).toFixed(1)} KB`);
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
