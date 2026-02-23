// ============================================================
// DocuAgent — Document Generation Engine (Stage 6)
// AI content generation + programmatic .docx assembly
// ============================================================

import { Document, Packer, Paragraph, Table } from "docx";
import sharp from "sharp";
import { getSupabase } from "../lib/supabase.js";
import { claudeText, parseJsonResponse } from "../lib/claude.js";
import { journeyProsePrompt } from "../prompts/journey-prose.js";
import { crossCuttingPrompt, productOverviewPrompt } from "../prompts/cross-cutting.js";
import {
  coverPage,
  tableOfContents,
  productOverviewSection,
  quickStartSection,
  navigationGuideSection,
  journeySection,
  screenReferenceSection,
  glossarySection,
  faqSection,
  confidenceAppendix,
} from "../doc-components/templates.js";
import { spacing } from "../doc-components/design-tokens.js";
import type {
  Screen,
  ScreenAnalysis,
  Journey,
  JourneyProse,
  CrossCuttingContent,
  PRDSummary,
} from "@docuagent/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocGenConfig {
  jobId: string;
  appName: string;
  prdSummary: PRDSummary | null;
  journeys: Journey[];
}

export interface DocGenResult {
  docUrl: string;
  fileSizeBytes: number;
  totalScreens: number;
  screenshotCount: number;
  sections: string[];
  avgConfidence: number;
  durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Fetch screenshot and resize
// ---------------------------------------------------------------------------

async function fetchAndResizeScreenshot(
  url: string,
): Promise<{ buffer: Buffer; width: number; height: number } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuf = await response.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuf);

    // Get metadata first
    const metadata = await sharp(inputBuffer).metadata();
    const origWidth = metadata.width ?? 1280;
    const origHeight = metadata.height ?? 800;

    // Resize to max 1280px wide, maintaining aspect ratio
    const resized = await sharp(inputBuffer)
      .resize({ width: 1280, withoutEnlargement: true })
      .png()
      .toBuffer();

    const resizedMeta = await sharp(resized).metadata();

    return {
      buffer: resized,
      width: resizedMeta.width ?? origWidth,
      height: resizedMeta.height ?? origHeight,
    };
  } catch (err) {
    console.error(`[doc-gen] Failed to fetch screenshot: ${url}`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// AI Content Generation — Phase A
// ---------------------------------------------------------------------------

async function generateJourneyProse(
  journeyTitle: string,
  journeyDescription: string,
  screens: Screen[],
): Promise<JourneyProse> {
  const screenAnalyses = screens
    .filter((s) => s.analysis)
    .map((s, idx) => ({
      stepNum: s.journey_step ?? idx,
      navPath: s.nav_path ?? "",
      analysis: s.analysis as ScreenAnalysis,
      screenshotRef: `screen_${s.order_index}`,
    }));

  if (screenAnalyses.length === 0) {
    return {
      overview: `This section covers the "${journeyTitle}" workflow.`,
      steps: [],
      tips: ["Refer to the screen reference appendix for detailed field information."],
      troubleshooting: ["If you encounter issues, contact your administrator."],
    };
  }

  const prompt = journeyProsePrompt({
    journeyTitle,
    journeyDescription,
    screenAnalyses,
  });

  try {
    const raw = await claudeText(prompt, { maxTokens: 4000, temperature: 0 });
    return parseJsonResponse<JourneyProse>(raw);
  } catch (err) {
    console.error(`[doc-gen] Journey prose generation failed for "${journeyTitle}":`, err);
    return {
      overview: `This section covers the "${journeyTitle}" workflow.`,
      steps: screenAnalyses.map((sa) => ({
        heading: `Step ${sa.stepNum + 1}: ${sa.analysis.page_title}`,
        body: sa.analysis.overview_paragraph,
        screenshot_ref: sa.screenshotRef,
      })),
      tips: ["Refer to the screen reference appendix for detailed field information."],
      troubleshooting: ["If you encounter issues, contact your administrator."],
    };
  }
}

async function generateCrossCuttingContent(
  appName: string,
  screens: Screen[],
  prdSummary: PRDSummary | null,
): Promise<CrossCuttingContent> {
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
    return parseJsonResponse<CrossCuttingContent>(raw);
  } catch (err) {
    console.error("[doc-gen] Cross-cutting content generation failed:", err);
    return {
      quick_start: { steps: ["Log in to the application.", "Explore the dashboard.", "Configure your settings."] },
      navigation_guide: `${appName} uses a sidebar navigation to organize its features. Click on items in the sidebar to navigate between different sections of the application.`,
      glossary: [{ term: appName, definition: `The ${appName} application.` }],
      faq: [{ question: `How do I get started with ${appName}?`, answer: "Log in and explore the dashboard to get familiar with the application." }],
    };
  }
}

async function generateProductOverview(
  appName: string,
  prdSummary: PRDSummary | null,
  screenCount: number,
): Promise<string> {
  const prompt = productOverviewPrompt({ appName, prdSummary, screenCount });

  try {
    const raw = await claudeText(prompt, { maxTokens: 500, temperature: 0 });
    const parsed = parseJsonResponse<{ overview: string }>(raw);
    return parsed.overview;
  } catch (err) {
    console.error("[doc-gen] Product overview generation failed:", err);
    return `${appName} is a web application designed to help teams manage their workflow efficiently. This documentation provides a comprehensive guide to all features and functionality.`;
  }
}

// ---------------------------------------------------------------------------
// Broadcast progress
// ---------------------------------------------------------------------------

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
// Main: Generate document
// ---------------------------------------------------------------------------

export async function runDocGenerator(config: DocGenConfig): Promise<DocGenResult> {
  const startTime = Date.now();
  const supabase = getSupabase();
  const sections: string[] = [];
  let screenshotCount = 0;

  console.log("[doc-gen] Starting document generation...");
  await broadcastProgress(config.jobId, "Generating document...");

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

  console.log(`[doc-gen] ${screens.length} screens total, ${analyzedScreens.length} analyzed`);

  // ----- Fetch all screenshots -----
  console.log("[doc-gen] Fetching screenshots...");
  const screenshotMap = new Map<string, { buffer: Buffer; width: number; height: number }>();

  await Promise.all(
    screens.map(async (screen) => {
      if (screen.screenshot_url) {
        const img = await fetchAndResizeScreenshot(screen.screenshot_url);
        if (img) {
          screenshotMap.set(`screen_${screen.order_index}`, img);
          screenshotCount++;
        }
      }
    }),
  );
  console.log(`[doc-gen] Fetched ${screenshotCount} screenshots`);

  // ----- Phase A: AI Content Generation -----
  console.log("[doc-gen] Phase A: Generating AI content...");
  await broadcastProgress(config.jobId, "Generating documentation content with AI...");

  // A1: Journey prose
  const journeyMap = new Map<string, Screen[]>();
  for (const screen of analyzedScreens) {
    const jid = screen.journey_id ?? "unknown";
    if (!journeyMap.has(jid)) journeyMap.set(jid, []);
    journeyMap.get(jid)!.push(screen);
  }

  // Build journey info from config or from screen data
  const journeyInfos: { id: string; title: string; description: string }[] = [];
  if (config.journeys && config.journeys.length > 0) {
    for (const j of config.journeys) {
      journeyInfos.push({ id: j.id, title: j.title, description: j.description });
    }
  } else {
    // Create journey info from unique journey IDs in screens
    for (const [jid, jScreens] of journeyMap) {
      const firstAnalysis = jScreens[0]?.analysis as ScreenAnalysis | null;
      journeyInfos.push({
        id: jid,
        title: firstAnalysis?.page_title ?? `Journey: ${jid}`,
        description: "Application workflow",
      });
    }
  }

  const journeyProseMap = new Map<string, JourneyProse>();
  for (const jInfo of journeyInfos) {
    const jScreens = journeyMap.get(jInfo.id) ?? [];
    if (jScreens.length === 0) continue;

    console.log(`[doc-gen] Generating prose for journey: ${jInfo.title} (${jScreens.length} screens)`);
    const prose = await generateJourneyProse(jInfo.title, jInfo.description, jScreens);
    journeyProseMap.set(jInfo.id, prose);
  }

  // A2: Cross-cutting content
  console.log("[doc-gen] Generating cross-cutting content...");
  const crossCutting = await generateCrossCuttingContent(
    config.appName,
    analyzedScreens,
    config.prdSummary,
  );

  // A3: Product overview
  console.log("[doc-gen] Generating product overview...");
  const productOverview = await generateProductOverview(
    config.appName,
    config.prdSummary,
    analyzedScreens.length,
  );

  // ----- Phase B: Programmatic .docx Assembly -----
  console.log("[doc-gen] Phase B: Assembling document...");
  await broadcastProgress(config.jobId, "Assembling document...");

  const docElements: (Paragraph | Table)[] = [];

  // 1. Cover page
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  docElements.push(...coverPage(config.appName, dateStr));
  sections.push("Cover Page");

  // 2. Table of Contents
  docElements.push(...tableOfContents());
  sections.push("Table of Contents");

  // 3. Product Overview
  docElements.push(...productOverviewSection(productOverview));
  sections.push("Product Overview");

  // 4. Quick Start
  docElements.push(...quickStartSection(crossCutting.quick_start.steps));
  sections.push("Quick Start Guide");

  // 5. Navigation Guide
  docElements.push(...navigationGuideSection(crossCutting.navigation_guide));
  sections.push("Navigation Guide");

  // 6. Journey Guides (PRIMARY content)
  for (const jInfo of journeyInfos) {
    const prose = journeyProseMap.get(jInfo.id);
    if (!prose) continue;

    // Build screenshot map for this journey
    const jScreens = journeyMap.get(jInfo.id) ?? [];
    const jScreenshotMap = new Map<string, { buffer: Buffer; width: number; height: number }>();
    for (const s of jScreens) {
      const key = `screen_${s.order_index}`;
      const img = screenshotMap.get(key);
      if (img) jScreenshotMap.set(key, img);
    }

    docElements.push(...journeySection(jInfo.title, prose, jScreenshotMap));
    sections.push(`Journey: ${jInfo.title}`);
  }

  // 7. Screen Reference appendix
  const screenRefs = analyzedScreens.map((s) => ({
    analysis: s.analysis as ScreenAnalysis,
    screenshot: screenshotMap.get(`screen_${s.order_index}`),
  }));
  docElements.push(...screenReferenceSection(screenRefs));
  sections.push("Screen Reference");

  // 8. Glossary
  if (crossCutting.glossary.length > 0) {
    docElements.push(...glossarySection(crossCutting.glossary));
    sections.push("Glossary");
  }

  // 9. FAQ
  if (crossCutting.faq.length > 0) {
    docElements.push(...faqSection(crossCutting.faq));
    sections.push("FAQ");
  }

  // 10. Confidence appendix
  const avgConfidence = analyzedScreens.length > 0
    ? analyzedScreens.reduce((sum, s) => sum + (s.confidence ?? 0), 0) / analyzedScreens.length
    : 0;

  const confidenceData = analyzedScreens.map((s) => {
    const analysis = s.analysis as ScreenAnalysis;
    return {
      title: analysis.page_title,
      confidence: s.confidence ?? 0,
      notes: s.code_context ? "Code + screenshot analysis" : "Screenshot analysis only",
    };
  });

  const { data: jobData } = await supabase
    .from("jobs")
    .select("quality_score")
    .eq("id", config.jobId)
    .single();

  docElements.push(...confidenceAppendix(confidenceData, jobData?.quality_score ?? 0));
  sections.push("Confidence Report");

  // ----- Build Document -----
  const doc = new Document({
    styles: {
      default: {
        heading1: {
          run: { bold: true, size: 48, color: "111827", font: "Calibri" },
          paragraph: { spacing: { before: 360, after: 200 } },
        },
        heading2: {
          run: { bold: true, size: 36, color: "1f2937", font: "Calibri" },
          paragraph: { spacing: { before: 280, after: 160 } },
        },
        heading3: {
          run: { bold: true, size: 28, color: "374151", font: "Calibri" },
          paragraph: { spacing: { before: 200, after: 120 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: spacing.pageWidth,
              height: spacing.pageHeight,
            },
            margin: {
              top: spacing.marginTop,
              bottom: spacing.marginBottom,
              left: spacing.marginLeft,
              right: spacing.marginRight,
            },
          },
        },
        children: docElements,
      },
    ],
  });

  // ----- Pack and upload -----
  console.log("[doc-gen] Packing document...");
  const buffer = await Packer.toBuffer(doc);
  const fileSizeBytes = buffer.byteLength;
  console.log(`[doc-gen] Document packed: ${(fileSizeBytes / 1024).toFixed(1)} KB`);

  // Upload to Supabase Storage
  const docPath = `documents/${config.jobId}/documentation.docx`;
  console.log("[doc-gen] Uploading to Supabase Storage...");

  const { error: uploadErr } = await supabase.storage
    .from("documents")
    .upload(docPath, buffer, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      upsert: true,
    });

  if (uploadErr) {
    console.error("[doc-gen] Upload failed:", uploadErr.message);
    // Try creating the bucket first
    try {
      await supabase.storage.createBucket("documents", { public: true });
      const { error: retryErr } = await supabase.storage
        .from("documents")
        .upload(docPath, buffer, {
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          upsert: true,
        });
      if (retryErr) throw retryErr;
    } catch (bucketErr) {
      console.error("[doc-gen] Bucket creation + retry failed:", bucketErr);
      throw new Error(`Document upload failed: ${uploadErr.message}`);
    }
  }

  const { data: urlData } = supabase.storage.from("documents").getPublicUrl(docPath);
  const docUrl = urlData.publicUrl;

  // ----- Update job record -----
  const durationSeconds = Math.round((Date.now() - startTime) / 1000);
  await supabase
    .from("jobs")
    .update({
      status: "completed",
      result: {
        doc_url: docUrl,
        total_screens: analyzedScreens.length,
        avg_confidence: Math.round(avgConfidence * 10) / 10,
        duration_seconds: durationSeconds,
      },
      completed_at: new Date().toISOString(),
    })
    .eq("id", config.jobId);

  await broadcastProgress(config.jobId, `Document generated! ${sections.length} sections, ${screenshotCount} screenshots, ${(fileSizeBytes / 1024).toFixed(0)} KB`);

  console.log(`\n[doc-gen] === Document Generation Complete ===`);
  console.log(`[doc-gen] Sections: ${sections.length}`);
  console.log(`[doc-gen] Screenshots: ${screenshotCount}`);
  console.log(`[doc-gen] File size: ${(fileSizeBytes / 1024).toFixed(1)} KB`);
  console.log(`[doc-gen] Duration: ${durationSeconds}s`);
  console.log(`[doc-gen] Download URL: ${docUrl}`);

  return {
    docUrl,
    fileSizeBytes,
    totalScreens: analyzedScreens.length,
    screenshotCount,
    sections,
    avgConfidence: Math.round(avgConfidence * 10) / 10,
    durationSeconds,
  };
}
