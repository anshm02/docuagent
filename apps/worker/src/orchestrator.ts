// ============================================================
// DocuAgent — Pipeline Orchestrator (V2)
// Coordinates all stages for a given job ID
// Pipeline: code analysis → PRD analysis → login + discovery →
//   cost estimation + journey planning → crawl → screen analysis → doc generation
// ============================================================

import { getSupabase } from "./lib/supabase.js";
import { runCodeAnalysis } from "./engines/code-analysis.js";
import { runPrdAnalysis } from "./engines/prd-analysis.js";
import { runDiscoveryCrawl } from "./engines/discovery-crawl.js";
import { runJourneyPlanner } from "./engines/journey-planner.js";
import { runCrawl } from "./engines/crawl.js";
import { runScreenAnalysis } from "./engines/screen-analysis.js";
import { runDocGenerator } from "./engines/doc-generator.js";
import {
  checkUserCredits,
  estimateCost,
  storeEstimatedCost,
  deductCredits,
  formatCostCents,
} from "./lib/cost-budget.js";
import { initStagehand, closeStagehand, waitForSettle } from "./lib/stagehand.js";
import type {
  Job,
  JobStatus,
  CrawlPlan,
  PRDSummary,
  Journey,
  DiscoveryResult,
  CostEstimate,
  JourneyPlanResult,
} from "@docuagent/shared";
import { PAGE_TIMEOUT_MS } from "@docuagent/shared";

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

const STAGE_ORDER: JobStatus[] = [
  "analyzing_code",
  "analyzing_prd",
  "discovering",
  "planning_journeys",
  "crawling",
  "analyzing_screens",
  "generating_docs",
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
// Analysis Visibility — Build detailed summaries
// ---------------------------------------------------------------------------

function buildCodeAnalysisSummary(crawlPlan: CrawlPlan): string {
  const totalFields = crawlPlan.routes.reduce((sum, r) => sum + r.fields.length, 0);
  const totalPermissions = crawlPlan.routes.reduce((sum, r) => sum + r.permissions.length, 0);
  const totalApiCalls = crawlPlan.routes.reduce((sum, r) => sum + r.apiCalls.length, 0);
  const formsCount = crawlPlan.routes.filter((r) => r.fields.length > 0).length;
  const routePaths = crawlPlan.routes.map((r) => r.path).join(", ");

  return [
    `Code Analysis Complete:`,
    `  Framework: ${crawlPlan.framework}`,
    `  Routes found: ${crawlPlan.routes.length}`,
    `  Components analyzed: ${crawlPlan.routes.length}`,
    `  Form fields extracted: ${totalFields} across ${formsCount} forms`,
    `  Permissions detected: ${totalPermissions} role-based checks`,
    `  API endpoints: ${totalApiCalls}`,
    `  Routes: ${routePaths}`,
  ].join("\n");
}

function buildPrdAnalysisSummary(prdSummary: PRDSummary, hadPrd: boolean): string {
  if (!hadPrd) {
    return "No PRD provided. Upload a product doc to add business context, workflow descriptions, and a glossary.";
  }

  const featureNames = prdSummary.main_features.map((f) => f.name).join(", ");
  const workflowNames = prdSummary.key_workflows.map((w) => w.name).join(", ");
  const roleNames = prdSummary.user_roles.map((r) => r.role).join(", ");

  return [
    `PRD Analysis Complete:`,
    `  Product: ${prdSummary.product_name}`,
    `  Target users: ${prdSummary.target_users.join(", ") || "not specified"}`,
    `  Features identified: ${prdSummary.main_features.length} — ${featureNames}`,
    `  Workflows mapped: ${prdSummary.key_workflows.length} — ${workflowNames}`,
    `  User roles: ${roleNames || "not specified"}`,
    `  Terminology: ${prdSummary.terminology.length} terms`,
  ].join("\n");
}

function buildDiscoverySummary(results: DiscoveryResult[]): string {
  const accessible = results.filter((r) => r.isAccessible && !r.hasError);
  const errorPages = results.filter((r) => r.hasError);

  const lines = [
    `Discovery Complete — ${accessible.length} accessible pages, ${errorPages.length} had errors (skipped)`,
  ];
  for (const r of accessible) {
    const features: string[] = [];
    if (r.hasForm) features.push("form");
    if (r.hasTable) features.push("table");
    const featureStr = features.length > 0 ? ` [${features.join(", ")}]` : "";
    lines.push(`  ${r.route}: "${r.pageTitle}"${featureStr}`);
  }
  for (const r of errorPages) {
    lines.push(`  ${r.route}: ERROR — skipped`);
  }

  return lines.join("\n");
}

function buildJourneyPlanSummary(
  planResult: JourneyPlanResult,
  costEstimate: CostEstimate,
): string {
  const lines = [
    `Documentation Plan — ${planResult.planned.length} journeys within ${formatCostCents(costEstimate.estimated_cost_cents)} budget:`,
  ];
  for (let i = 0; i < planResult.planned.length; i++) {
    const j = planResult.planned[i];
    lines.push(`  ${i + 1}. ${j.title} (${j.steps.length} steps) — ${j.description}`);
  }
  if (costEstimate.journeys_cut_for_budget > 0) {
    lines.push(`  Note: ${costEstimate.journeys_cut_for_budget} additional journeys available with more credits`);
  }
  if (planResult.additional.length > 0) {
    lines.push(`  Available with upgrade: ${planResult.additional.map((a) => a.title).join(", ")}`);
  }
  return lines.join("\n");
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

  // ═════════════════════════════════════════════════
  // Credit check before starting
  // ═════════════════════════════════════════════════
  const { hasCredits, credits: userCredits } = await checkUserCredits(typedJob.user_id);
  if (!hasCredits) {
    await failJob(jobId, "No credits remaining. Please upgrade your plan to continue generating documentation.");
    return;
  }
  console.log(`[orchestrator] User credits: ${formatCostCents(userCredits)}`);

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
  let discoveryResults: DiscoveryResult[] = [];
  let journeys: Journey[] = [];
  let additionalJourneys: { title: string; description: string }[] = [];
  let costEstimate: CostEstimate | null = null;
  let screensCaptured = 0;
  let hadPrd = false;

  try {
    // ═════════════════════════════════════════════════
    // Stage 1: Code Analysis
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "analyzing_code");
    await broadcastProgress(jobId, "info", "Analyzing codebase...");

    try {
      crawlPlan = await runCodeAnalysis(typedJob.github_repo_url);
      console.log(`[orchestrator] Code analysis complete: ${crawlPlan.framework}, ${crawlPlan.routes.length} routes`);

      // Build and broadcast code analysis summary
      const codeAnalysisSummary = typedJob.github_repo_url
        ? buildCodeAnalysisSummary(crawlPlan)
        : "No codebase provided. Connect GitHub to get field validation rules, permission details, and richer documentation.";

      await broadcastProgress(jobId, "info", codeAnalysisSummary);

      // Store summary on job record
      await supabase
        .from("jobs")
        .update({ code_analysis_summary: codeAnalysisSummary })
        .eq("id", jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] Code analysis failed (non-fatal):", msg);
      const fallbackSummary = "Code analysis failed, will use browser navigation fallback";
      await broadcastProgress(jobId, "info", fallbackSummary);
      await supabase
        .from("jobs")
        .update({ code_analysis_summary: fallbackSummary })
        .eq("id", jobId);
    }

    // ═════════════════════════════════════════════════
    // Stage 2: PRD Analysis
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "analyzing_prd");
    await broadcastProgress(jobId, "info", "Analyzing product description...");

    hadPrd = !!(typedJob.product_description || typedJob.prd_file_path);

    try {
      prdSummary = await runPrdAnalysis({
        productDescription: typedJob.product_description,
      });
      console.log(`[orchestrator] PRD analysis complete: ${prdSummary.product_name}`);

      // Build and broadcast PRD analysis summary
      const prdAnalysisSummary = buildPrdAnalysisSummary(prdSummary, hadPrd);
      await broadcastProgress(jobId, "info", prdAnalysisSummary);

      // Store summary on job record
      await supabase
        .from("jobs")
        .update({ prd_analysis_summary: prdAnalysisSummary })
        .eq("id", jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] PRD analysis failed (non-fatal):", msg);
      const fallbackSummary = "PRD analysis failed, continuing with basic context";
      await broadcastProgress(jobId, "info", fallbackSummary);
      await supabase
        .from("jobs")
        .update({ prd_analysis_summary: fallbackSummary })
        .eq("id", jobId);
    }

    // ═════════════════════════════════════════════════
    // Stage 3: Login + Discovery Crawl
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "discovering");
    await broadcastProgress(jobId, "info", "Initializing browser for discovery...");

    console.log("[orchestrator] Initializing Stagehand for discovery...");
    const { stagehand, page } = await initStagehand();

    try {
      // Authenticate first
      if (typedJob.login_url && typedJob.credentials) {
        await broadcastProgress(jobId, "info", "Logging in...");
        console.log(`[orchestrator] Navigating to login page: ${typedJob.login_url}`);
        await page.goto(typedJob.login_url, {
          waitUntil: "networkidle",
          timeoutMs: PAGE_TIMEOUT_MS,
        });
        await waitForSettle(page);

        const priorUrl = page.url();

        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) {
            console.log("[orchestrator] Retrying login...");
            await page.goto(typedJob.login_url!, {
              waitUntil: "networkidle",
              timeoutMs: PAGE_TIMEOUT_MS,
            });
            await waitForSettle(page);
          }

          try {
            await stagehand.act(
              `Type "${typedJob.credentials!.username}" into the email or username input field`,
              { timeout: 15_000 },
            );
            await stagehand.act(
              `Type "${typedJob.credentials!.password}" into the password input field`,
              { timeout: 15_000 },
            );
            await stagehand.act("Click the sign in, log in, or submit button", {
              timeout: 15_000,
            });
            await waitForSettle(page);
            await page.waitForTimeout(3000);

            const currentUrl = page.url();
            const loginPatterns = ["/login", "/sign-in", "/signin", "/sign-up", "/signup", "/auth"];
            const stillOnLogin = loginPatterns.some((p) => currentUrl.toLowerCase().includes(p));

            if (!stillOnLogin || currentUrl !== priorUrl) {
              console.log("[orchestrator] Login succeeded!");
              await broadcastProgress(jobId, "info", "Login successful!");
              break;
            }
          } catch (err) {
            console.error(`[orchestrator] Login attempt ${attempt + 1} failed:`, err);
            if (attempt === 1) {
              await closeStagehand();
              await failJob(jobId, "Login failed after 2 attempts. Check your credentials and login URL.");
              await deleteCredentials(jobId);
              return;
            }
          }
        }
      } else {
        // No login required — navigate to app URL
        await page.goto(typedJob.app_url, {
          waitUntil: "networkidle",
          timeoutMs: PAGE_TIMEOUT_MS,
        });
        await waitForSettle(page);
      }

      // Run discovery crawl (no AI calls — free)
      discoveryResults = await runDiscoveryCrawl({
        jobId,
        page,
        appUrl: typedJob.app_url,
        crawlPlan,
      });

      // Store discovery data on job
      await supabase
        .from("jobs")
        .update({ discovery_data: discoveryResults })
        .eq("id", jobId);

      // Broadcast discovery summary
      const discoverySummary = buildDiscoverySummary(discoveryResults);
      await broadcastProgress(jobId, "info", discoverySummary);

      console.log(`[orchestrator] Discovery complete: ${discoveryResults.length} routes visited`);
    } finally {
      await closeStagehand();
    }

    // Delete credentials after login + discovery (no longer needed)
    await deleteCredentials(jobId);

    // ═════════════════════════════════════════════════
    // Stage 4: Cost Estimation + Journey Planning
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "planning_journeys");
    await broadcastProgress(jobId, "info", "Planning user journeys...");

    // Estimate how many journeys we can afford
    const accessiblePages = discoveryResults.filter((r) => r.isAccessible && !r.hasError);
    // Rough estimate: possible journeys = accessible pages / 3 (avg 3 pages per journey)
    const estimatedPossibleJourneys = Math.max(1, Math.ceil(accessiblePages.length / 3));

    costEstimate = estimateCost(discoveryResults, estimatedPossibleJourneys, userCredits);
    await storeEstimatedCost(jobId, costEstimate.estimated_cost_cents);

    // Broadcast budget info
    const budgetMsg = `Budget: ${formatCostCents(userCredits)} available. Estimating ${formatCostCents(costEstimate.estimated_cost_cents)} for ${costEstimate.journeys_planned} journeys (${costEstimate.screens_estimated} screens).`;
    console.log(`[orchestrator] ${budgetMsg}`);
    await broadcastProgress(jobId, "info", budgetMsg);

    try {
      const planResult = await runJourneyPlanner(
        crawlPlan,
        prdSummary,
        discoveryResults,
        costEstimate.journeys_planned,
      );

      journeys = planResult.planned;
      additionalJourneys = planResult.additional;

      // Recalculate cost estimate with actual journey count
      costEstimate = estimateCost(
        discoveryResults,
        journeys.length + additionalJourneys.length,
        userCredits,
      );

      console.log(`[orchestrator] Journey planning complete: ${journeys.length} planned, ${additionalJourneys.length} additional`);

      // Broadcast journey plan summary
      const planSummary = buildJourneyPlanSummary(planResult, costEstimate);
      await broadcastProgress(jobId, "info", planSummary);

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
    // Stage 5: Crawl Execution
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
        return;
      }

      console.log(`[orchestrator] Crawl partially failed but ${screensCaptured} screens captured, continuing...`);
      await broadcastProgress(jobId, "info", `Crawl partially failed, continuing with ${screensCaptured} screens`);
    }

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
    // Stage 6: Screen Analysis
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
    // Stage 7: Document Generation
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "generating_docs");
    await broadcastProgress(jobId, "info", "Generating documentation...");

    try {
      const docResult = await runDocGenerator({
        jobId,
        appName,
        prdSummary,
        journeys,
      });

      // Calculate actual cost (rough estimate based on API calls made)
      const actualCostCents = costEstimate?.estimated_cost_cents ?? 100;

      // Deduct credits
      await deductCredits(typedJob.user_id, jobId, actualCostCents);

      // Update job with final result
      const totalDurationSeconds = Math.round((Date.now() - startTime) / 1000);
      const journeysCompleted = journeys.length; // TODO: track actual completion per journey

      await supabase
        .from("jobs")
        .update({
          status: "completed",
          result: {
            docs_url: docResult.docUrl,
            zip_url: docResult.docUrl, // same for now, will be different when zip is separate
            total_screens: docResult.totalScreens,
            avg_confidence: docResult.avgConfidence,
            duration_seconds: totalDurationSeconds,
            journeys_completed: journeysCompleted,
            journeys_total: journeys.length + additionalJourneys.length,
            estimated_cost_cents: costEstimate?.estimated_cost_cents ?? 0,
            actual_cost_cents: actualCostCents,
            additional_journeys: additionalJourneys,
          },
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId);

      await broadcastProgress(
        jobId,
        "complete",
        `Documentation generated! ${docResult.totalScreens} screens, ${docResult.sections.length} sections, ${(docResult.fileSizeBytes / 1024).toFixed(0)} KB. Cost: ${formatCostCents(actualCostCents)}`,
      );

      console.log(`\n[orchestrator] ════════════════════════════════════════`);
      console.log(`[orchestrator] PIPELINE COMPLETE`);
      console.log(`[orchestrator] Duration: ${totalDurationSeconds}s`);
      console.log(`[orchestrator] Screens: ${docResult.totalScreens}`);
      console.log(`[orchestrator] Doc size: ${(docResult.fileSizeBytes / 1024).toFixed(1)} KB`);
      console.log(`[orchestrator] Quality: ${docResult.avgConfidence}/5 avg confidence`);
      console.log(`[orchestrator] Cost: ${formatCostCents(actualCostCents)}`);
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
