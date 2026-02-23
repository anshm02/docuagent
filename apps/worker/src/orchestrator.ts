// ============================================================
// DocuAgent — Pipeline Orchestrator
// Coordinates all 6 stages for a given job ID
// ============================================================

import { getSupabase } from "./lib/supabase.js";
import { runCodeAnalysis } from "./engines/code-analysis.js";
import { runPrdAnalysis } from "./engines/prd-analysis.js";
import { runJourneyPlanner } from "./engines/journey-planner.js";
import { runCrawl } from "./engines/crawl.js";
import { runScreenAnalysis } from "./engines/screen-analysis.js";
import { runDocGenerator } from "./engines/doc-generator.js";
import type { Job, JobStatus, CrawlPlan, PRDSummary, Journey } from "@docuagent/shared";

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

const STAGE_ORDER: JobStatus[] = [
  "analyzing_code",
  "analyzing_prd",
  "planning_journeys",
  "crawling",
  "analyzing_screens",
  "generating_doc",
];

async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  extra?: Record<string, unknown>,
): Promise<void> {
  const supabase = getSupabase();
  const update: Record<string, unknown> = { status, ...extra };
  if (status === STAGE_ORDER[0]) {
    update.started_at = new Date().toISOString();
  }
  const { error } = await supabase.from("jobs").update(update).eq("id", jobId);
  if (error) {
    console.error(`[orchestrator] Failed to update status to ${status}:`, error.message);
  }
  console.log(`\n[orchestrator] ═══ Status: ${status} ═══`);
}

async function failJob(jobId: string, errorMsg: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("jobs")
    .update({
      status: "failed",
      error: errorMsg,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);
  console.error(`[orchestrator] JOB FAILED: ${errorMsg}`);
}

async function broadcastProgress(
  jobId: string,
  type: "info" | "error" | "complete",
  message: string,
): Promise<void> {
  try {
    const supabase = getSupabase();
    await supabase.from("progress_messages").insert({
      job_id: jobId,
      type,
      message,
    });
  } catch {
    // non-critical
  }
}

// ---------------------------------------------------------------------------
// Delete credentials after use
// ---------------------------------------------------------------------------

async function deleteCredentials(jobId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("jobs")
    .update({ credentials: null })
    .eq("id", jobId);
  if (error) {
    console.error("[orchestrator] Failed to delete credentials:", error.message);
  } else {
    console.log("[orchestrator] Credentials deleted from job record");
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runPipeline(jobId: string): Promise<void> {
  const startTime = Date.now();
  console.log(`\n[orchestrator] ════════════════════════════════════════`);
  console.log(`[orchestrator] Starting pipeline for job: ${jobId}`);
  console.log(`[orchestrator] ════════════════════════════════════════\n`);

  const supabase = getSupabase();

  // Fetch job record
  const { data: job, error: fetchErr } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (fetchErr || !job) {
    console.error("[orchestrator] Failed to fetch job:", fetchErr?.message ?? "not found");
    return;
  }

  const typedJob = job as Job;
  const appName = typedJob.app_name ?? new URL(typedJob.app_url).hostname;

  let crawlPlan: CrawlPlan = { framework: "unknown", routes: [] };
  let prdSummary: PRDSummary = {
    product_name: appName,
    product_purpose: "No description provided",
    target_users: [],
    main_features: [],
    key_workflows: [],
    user_roles: [],
    terminology: [],
  };
  let journeys: Journey[] = [];
  let screensCaptured = 0;

  try {
    // ═════════════════════════════════════════════════
    // Stage 1: Code Analysis
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "analyzing_code");
    await broadcastProgress(jobId, "info", "Analyzing codebase...");

    try {
      crawlPlan = await runCodeAnalysis(typedJob.github_repo_url);
      console.log(`[orchestrator] Code analysis complete: ${crawlPlan.framework}, ${crawlPlan.routes.length} routes`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] Code analysis failed (non-fatal):", msg);
      await broadcastProgress(jobId, "info", "Code analysis failed, will use browser navigation fallback");
    }

    // ═════════════════════════════════════════════════
    // Stage 2: PRD Analysis
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "analyzing_prd");
    await broadcastProgress(jobId, "info", "Analyzing product description...");

    try {
      prdSummary = await runPrdAnalysis({
        productDescription: typedJob.product_description,
      });
      console.log(`[orchestrator] PRD analysis complete: ${prdSummary.product_name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] PRD analysis failed (non-fatal):", msg);
      await broadcastProgress(jobId, "info", "PRD analysis failed, continuing with basic context");
    }

    // ═════════════════════════════════════════════════
    // Stage 3: Journey Planning
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "planning_journeys");
    await broadcastProgress(jobId, "info", "Planning user journeys...");

    try {
      journeys = await runJourneyPlanner(crawlPlan, prdSummary);
      console.log(`[orchestrator] Journey planning complete: ${journeys.length} journeys`);

      // Store journeys in job record
      await supabase
        .from("jobs")
        .update({ journeys })
        .eq("id", jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] Journey planning failed (non-fatal):", msg);
      await broadcastProgress(jobId, "info", "Journey planning failed, will discover navigation via browser");
    }

    // ═════════════════════════════════════════════════
    // Stage 4: Crawl Execution
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "crawling");
    await broadcastProgress(jobId, "info", "Crawling application...");

    try {
      const crawlResult = await runCrawl({
        jobId,
        appUrl: typedJob.app_url,
        loginUrl: typedJob.login_url ?? undefined,
        credentials: typedJob.credentials ?? undefined,
        journeys,
        crawlPlan,
        maxScreens: typedJob.config?.max_screens,
      });

      screensCaptured = crawlResult.screens.length;
      console.log(`[orchestrator] Crawl complete: ${screensCaptured} screens, ${crawlResult.errors.length} errors`);

      // Update progress
      await supabase
        .from("jobs")
        .update({
          progress: {
            screens_found: screensCaptured,
            screens_crawled: screensCaptured,
            current_step: "Crawl complete",
          },
        })
        .eq("id", jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] Crawl failed:", msg);

      // Check if we have enough screens for partial doc generation
      const { count } = await supabase
        .from("screens")
        .select("*", { count: "exact", head: true })
        .eq("job_id", jobId)
        .eq("status", "crawled");

      screensCaptured = count ?? 0;

      if (screensCaptured < 3) {
        await failJob(jobId, `Crawl failed with only ${screensCaptured} screens captured: ${msg}`);
        await deleteCredentials(jobId);
        return;
      }

      console.log(`[orchestrator] Crawl partially failed but ${screensCaptured} screens captured, continuing...`);
      await broadcastProgress(jobId, "info", `Crawl partially failed, continuing with ${screensCaptured} screens`);
    }

    // Delete credentials immediately after crawl (whether success or partial failure)
    await deleteCredentials(jobId);

    // Check minimum screens
    if (screensCaptured < 3) {
      const { count } = await supabase
        .from("screens")
        .select("*", { count: "exact", head: true })
        .eq("job_id", jobId)
        .eq("status", "crawled");

      screensCaptured = count ?? 0;

      if (screensCaptured < 3) {
        await failJob(jobId, `Only ${screensCaptured} screens captured, need at least 3 for document generation`);
        return;
      }
    }

    // ═════════════════════════════════════════════════
    // Stage 5: Screen Analysis
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "analyzing_screens");
    await broadcastProgress(jobId, "info", `Analyzing ${screensCaptured} screens with AI vision...`);

    try {
      const analysisResult = await runScreenAnalysis({
        jobId,
        appName,
        prdSummary,
        journeys: journeys.map((j) => ({ id: j.id, title: j.title, description: j.description })),
      });

      console.log(`[orchestrator] Screen analysis complete: ${analysisResult.analyzedScreens}/${analysisResult.totalScreens}, quality: ${analysisResult.qualityScore}%`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] Screen analysis failed:", msg);
      await broadcastProgress(jobId, "error", `Screen analysis failed: ${msg}`);
      // Continue to doc generation with whatever analysis we have
    }

    // ═════════════════════════════════════════════════
    // Stage 6: Document Generation
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "generating_doc");
    await broadcastProgress(jobId, "info", "Generating documentation...");

    try {
      const docResult = await runDocGenerator({
        jobId,
        appName,
        prdSummary,
        journeys,
      });

      // Update job with final result
      const totalDurationSeconds = Math.round((Date.now() - startTime) / 1000);
      await supabase
        .from("jobs")
        .update({
          status: "completed",
          result: {
            doc_url: docResult.docUrl,
            total_screens: docResult.totalScreens,
            avg_confidence: docResult.avgConfidence,
            duration_seconds: totalDurationSeconds,
          },
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId);

      await broadcastProgress(jobId, "complete", `Documentation generated! ${docResult.totalScreens} screens, ${docResult.sections.length} sections, ${(docResult.fileSizeBytes / 1024).toFixed(0)} KB`);

      console.log(`\n[orchestrator] ════════════════════════════════════════`);
      console.log(`[orchestrator] PIPELINE COMPLETE`);
      console.log(`[orchestrator] Duration: ${totalDurationSeconds}s`);
      console.log(`[orchestrator] Screens: ${docResult.totalScreens}`);
      console.log(`[orchestrator] Doc size: ${(docResult.fileSizeBytes / 1024).toFixed(1)} KB`);
      console.log(`[orchestrator] Quality: ${docResult.avgConfidence}/5 avg confidence`);
      console.log(`[orchestrator] Download: ${docResult.docUrl}`);
      console.log(`[orchestrator] ════════════════════════════════════════\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await failJob(jobId, `Document generation failed: ${msg}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failJob(jobId, `Pipeline error: ${msg}`);
    // Ensure credentials are cleaned up even on unexpected errors
    await deleteCredentials(jobId);
  }
}
