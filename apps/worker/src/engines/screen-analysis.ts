import { getSupabase } from "../lib/supabase.js";
import { claudeVision, parseJsonResponse } from "../lib/claude.js";
import { screenAnalysisPrompt } from "../prompts/screen-analysis.js";
import type { ScreenAnalysis, Screen, PRDSummary } from "@docuagent/shared";
import { CONCURRENT_ANALYSIS_BATCH, CONFIDENCE_THRESHOLD, QUALITY_SCORE_MIN } from "@docuagent/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalysisConfig {
  jobId: string;
  appName: string;
  prdSummary: PRDSummary | null;
  features: { id: string; name: string; slug: string; description: string }[];
}

export interface AnalysisResult {
  totalScreens: number;
  analyzedScreens: number;
  failedScreens: number;
  averageConfidence: number;
  qualityScore: number;
  flaggedForReview: boolean;
  failures: { screenId: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Fetch screenshot as base64
// ---------------------------------------------------------------------------

async function fetchScreenshotBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch screenshot: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

// ---------------------------------------------------------------------------
// Analyze a single screen
// ---------------------------------------------------------------------------

async function analyzeScreen(
  screen: Screen,
  config: AnalysisConfig,
): Promise<{ analysis: ScreenAnalysis; error: null } | { analysis: null; error: string }> {
  const { appName, prdSummary, features } = config;

  // Find feature context
  const feature = features.find((f) => f.id === screen.journey_id);
  const featureName = feature?.name ?? "Application Page";
  const featureDescription = feature?.description ?? "Application feature";
  // Use screenshot label context from nav_path or fall back
  const screenshotLabel = (screen as any).screenshot_label ?? "page";

  // Fetch screenshot
  if (!screen.screenshot_url) {
    return { analysis: null, error: "No screenshot URL" };
  }

  let imageBase64: string;
  try {
    imageBase64 = await fetchScreenshotBase64(screen.screenshot_url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { analysis: null, error: `Screenshot fetch failed: ${msg}` };
  }

  // Build prompt
  const prompt = screenAnalysisPrompt({
    appName,
    domHtml: screen.dom_html ?? "",
    codeContext: screen.code_context,
    prdSummary,
    featureName,
    featureDescription,
    screenshotLabel,
    navPath: screen.nav_path ?? "",
  });

  // Call Claude Vision
  try {
    const raw = await claudeVision(prompt, imageBase64, {
      maxTokens: 2000,
      temperature: 0,
    });
    const analysis = parseJsonResponse<ScreenAnalysis>(raw);

    // Validate required fields
    if (!analysis.page_title || typeof analysis.confidence !== "number") {
      return { analysis: null, error: "Invalid analysis response: missing page_title or confidence" };
    }

    // Ensure arrays exist
    analysis.fields = analysis.fields ?? [];
    analysis.actions = analysis.actions ?? [];
    analysis.keyboard_shortcuts = analysis.keyboard_shortcuts ?? [];
    analysis.permissions = analysis.permissions ?? [];
    analysis.related_screens = analysis.related_screens ?? [];
    analysis.tips = analysis.tips ?? [];
    analysis.troubleshooting = analysis.troubleshooting ?? [];

    return { analysis, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { analysis: null, error: `Claude analysis failed: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Store analysis result
// ---------------------------------------------------------------------------

async function storeAnalysis(
  screenId: string,
  analysis: ScreenAnalysis,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("screens")
    .update({
      analysis,
      confidence: analysis.confidence,
      status: "analyzed",
    })
    .eq("id", screenId);

  if (error) {
    console.error(`[screen-analysis] Failed to store analysis for ${screenId}:`, error.message);
    throw error;
  }
}

async function markScreenFailed(screenId: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("screens")
    .update({ status: "failed" })
    .eq("id", screenId);
}

// ---------------------------------------------------------------------------
// Broadcast progress
// ---------------------------------------------------------------------------

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
// Main: Run screen analysis for all crawled screens
// ---------------------------------------------------------------------------

export async function runScreenAnalysis(config: AnalysisConfig): Promise<AnalysisResult> {
  const supabase = getSupabase();

  // Fetch all crawled screens for this job
  const { data: screens, error: fetchErr } = await supabase
    .from("screens")
    .select("*")
    .eq("job_id", config.jobId)
    .eq("status", "crawled")
    .order("order_index");

  if (fetchErr) {
    throw new Error(`Failed to fetch screens: ${fetchErr.message}`);
  }

  if (!screens || screens.length === 0) {
    console.log("[screen-analysis] No crawled screens to analyze");
    return {
      totalScreens: 0,
      analyzedScreens: 0,
      failedScreens: 0,
      averageConfidence: 0,
      qualityScore: 0,
      flaggedForReview: true,
      failures: [],
    };
  }

  console.log(`[screen-analysis] Analyzing ${screens.length} screens (batch size: ${CONCURRENT_ANALYSIS_BATCH})`);
  await broadcastProgress(config.jobId, `Analyzing ${screens.length} screens...`);

  const failures: { screenId: string; error: string }[] = [];
  let analyzedCount = 0;
  let totalConfidence = 0;
  let highConfidenceCount = 0;

  // Process in batches
  for (let i = 0; i < screens.length; i += CONCURRENT_ANALYSIS_BATCH) {
    const batch = screens.slice(i, i + CONCURRENT_ANALYSIS_BATCH);
    const batchNum = Math.floor(i / CONCURRENT_ANALYSIS_BATCH) + 1;
    const totalBatches = Math.ceil(screens.length / CONCURRENT_ANALYSIS_BATCH);
    console.log(`[screen-analysis] Batch ${batchNum}/${totalBatches} (${batch.length} screens)`);

    await Promise.all(
      batch.map(async (screen) => {
        const typedScreen = screen as Screen;
        console.log(`[screen-analysis] Analyzing: ${typedScreen.nav_path ?? typedScreen.url}`);
        const result = await analyzeScreen(typedScreen, config);

        if (result.analysis) {
          await storeAnalysis(typedScreen.id, result.analysis);
          analyzedCount++;
          totalConfidence += result.analysis.confidence;
          if (result.analysis.confidence >= CONFIDENCE_THRESHOLD) {
            highConfidenceCount++;
          }
          console.log(`[screen-analysis] Done: ${typedScreen.nav_path}: confidence=${result.analysis.confidence}`);
        } else {
          await markScreenFailed(typedScreen.id);
          failures.push({ screenId: typedScreen.id, error: result.error });
          console.error(`[screen-analysis] Failed: ${typedScreen.nav_path}: ${result.error}`);
        }

        return result;
      }),
    );
  }

  const averageConfidence = analyzedCount > 0 ? totalConfidence / analyzedCount : 0;
  const qualityScore = analyzedCount > 0
    ? Math.round((highConfidenceCount / analyzedCount) * 100)
    : 0;
  const flaggedForReview = qualityScore < QUALITY_SCORE_MIN;

  // Update job with quality score
  await supabase
    .from("jobs")
    .update({
      quality_score: qualityScore,
      flagged_for_review: flaggedForReview,
    })
    .eq("id", config.jobId);

  await broadcastProgress(
    config.jobId,
    `Screen analysis complete: ${analyzedCount}/${screens.length} screens analyzed, avg confidence: ${averageConfidence.toFixed(1)}, quality score: ${qualityScore}%`,
  );

  console.log(`\n[screen-analysis] === Analysis Complete ===`);
  console.log(`[screen-analysis] Analyzed: ${analyzedCount}/${screens.length}`);
  console.log(`[screen-analysis] Failed: ${failures.length}`);
  console.log(`[screen-analysis] Avg confidence: ${averageConfidence.toFixed(1)}`);
  console.log(`[screen-analysis] Quality score: ${qualityScore}%`);
  console.log(`[screen-analysis] Flagged for review: ${flaggedForReview}`);

  return {
    totalScreens: screens.length,
    analyzedScreens: analyzedCount,
    failedScreens: failures.length,
    averageConfidence: Math.round(averageConfidence * 10) / 10,
    qualityScore,
    flaggedForReview,
    failures,
  };
}
