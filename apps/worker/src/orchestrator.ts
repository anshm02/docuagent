// ============================================================
// DocuAgent — Pipeline Orchestrator (Feature-based)
// Pipeline: code analysis → PRD analysis → login + discovery →
//   feature selection → feature crawl → screen analysis → doc generation
// ============================================================

import { getSupabase } from "./lib/supabase.js";
import { runCodeAnalysis } from "./engines/code-analysis.js";
import { runPrdAnalysis } from "./engines/prd-analysis.js";
import { runDiscoveryCrawl } from "./engines/discovery-crawl.js";
import { selectFeatures } from "./engines/feature-planner.js";
import { runCrawl, findLoginPage, detectAppName } from "./engines/crawl.js";
import { runScreenAnalysis } from "./engines/screen-analysis.js";
import { runMarkdownGenerator } from "./engines/markdown-generator.js";
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
  Feature,
  DiscoveryResult,
  CostEstimate,
  FeatureSelectionResult,
} from "@docuagent/shared";
import { PAGE_TIMEOUT_MS } from "@docuagent/shared";

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

const STAGE_ORDER: JobStatus[] = [
  "analyzing_code",
  "analyzing_prd",
  "discovering",
  "planning_journeys", // DB constraint uses planning_journeys; this is the feature selection stage
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

function buildFeatureSelectionSummary(
  selectionResult: FeatureSelectionResult,
  costEstimate: CostEstimate,
): string {
  const lines = [
    `Selected ${selectionResult.selected.length} features to document (budget: ${formatCostCents(costEstimate.estimated_cost_cents)}):`,
  ];
  for (let i = 0; i < selectionResult.selected.length; i++) {
    const f = selectionResult.selected[i];
    lines.push(`  ${i + 1}. ${f.name} (${f.route}) ${f.hasForm ? "[has form]" : ""}`);
  }
  if (costEstimate.features_cut_for_budget > 0) {
    lines.push(`  Note: ${costEstimate.features_cut_for_budget} additional features available with more credits`);
  }
  if (selectionResult.additional.length > 0) {
    lines.push(`  Available with upgrade: ${selectionResult.additional.map((a) => a.title).join(", ")}`);
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
  let appName = typedJob.app_name ?? "";

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
  let features: Feature[] = [];
  let additionalFeatures: { title: string; description: string }[] = [];
  let costEstimate: CostEstimate | null = null;
  let screensCaptured = 0;
  let hadPrd = false;
  let loginUrl: string | null | undefined = typedJob.login_url;

  try {
    // ═════════════════════════════════════════════════
    // Stage 1: Code Analysis
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "analyzing_code");
    await broadcastProgress(jobId, "info", "Analyzing codebase...");

    try {
      crawlPlan = await runCodeAnalysis(typedJob.github_repo_url);
      console.log(`[orchestrator] Code analysis complete: ${crawlPlan.framework}, ${crawlPlan.routes.length} routes`);

      const codeAnalysisSummary = typedJob.github_repo_url
        ? buildCodeAnalysisSummary(crawlPlan)
        : "No codebase provided. Connect GitHub to get field validation rules, permission details, and richer documentation.";

      await broadcastProgress(jobId, "info", codeAnalysisSummary);
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

      const prdAnalysisSummary = buildPrdAnalysisSummary(prdSummary, hadPrd);
      await broadcastProgress(jobId, "info", prdAnalysisSummary);
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
    await broadcastProgress(jobId, "info", "Discovering app features...");

    console.log("[orchestrator] Initializing Stagehand for discovery...");
    const { stagehand, page } = await initStagehand();

    try {
      // Determine login URL (auto-detect if not provided)
      const hasCredentials = !!(typedJob.credentials?.username && typedJob.credentials?.password);

      if (!loginUrl && hasCredentials) {
        await broadcastProgress(jobId, "info", "Auto-detecting login page...");
        loginUrl = await findLoginPage(stagehand, page, typedJob.app_url, true);
        if (!loginUrl) {
          await closeStagehand();
          await failJob(jobId, "Could not find login page. Please provide the login URL.");
          await deleteCredentials(jobId);
          return;
        }
        console.log(`[orchestrator] Auto-detected login URL: ${loginUrl}`);
        await broadcastProgress(jobId, "info", `Found login page: ${loginUrl}`);
      }

      // Authenticate
      if (loginUrl && typedJob.credentials) {
        await broadcastProgress(jobId, "info", "Logging in...");
        console.log(`[orchestrator] Navigating to login page: ${loginUrl}`);
        await page.goto(loginUrl, {
          waitUntil: "networkidle",
          timeoutMs: PAGE_TIMEOUT_MS,
        });
        await waitForSettle(page);

        const priorUrl = page.url();

        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) {
            console.log("[orchestrator] Retrying login...");
            await page.goto(loginUrl!, {
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

        // Verify login actually succeeded (post-loop check)
        const postLoginUrl = page.url();
        const loginPatterns = ["/login", "/sign-in", "/signin", "/sign-up", "/signup", "/auth"];
        const stillOnLoginPage = loginPatterns.some((p) => postLoginUrl.toLowerCase().includes(p));
        if (stillOnLoginPage) {
          console.error(`[orchestrator] Login loop completed but still on login page: ${postLoginUrl}`);
          await closeStagehand();
          await failJob(jobId, "Login failed — still on login page after 2 attempts. Check your credentials and login URL.");
          await deleteCredentials(jobId);
          return;
        }
      } else if (!hasCredentials) {
        await page.goto(typedJob.app_url, {
          waitUntil: "networkidle",
          timeoutMs: PAGE_TIMEOUT_MS,
        });
        await waitForSettle(page);
      }

      // Detect app name
      if (!appName) {
        appName = await detectAppName(stagehand, page, typedJob.product_description);
        await supabase.from("jobs").update({ app_name: appName }).eq("id", jobId);
        console.log(`[orchestrator] App name: "${appName}"`);
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
    // Stage 4: Feature Selection + Cost Estimation
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "planning_journeys");
    await broadcastProgress(jobId, "info", "Selecting features to document...");

    // Count accessible pages as potential features
    const accessiblePages = discoveryResults.filter((r) => r.isAccessible && !r.hasError);

    costEstimate = estimateCost(discoveryResults, accessiblePages.length, userCredits);
    await storeEstimatedCost(jobId, costEstimate.estimated_cost_cents);

    // Broadcast budget info
    const budgetMsg = `Budget: ${formatCostCents(userCredits)} available. Estimating ${formatCostCents(costEstimate.estimated_cost_cents)} for ${costEstimate.features_planned} features (${costEstimate.screens_estimated} screens).`;
    console.log(`[orchestrator] ${budgetMsg}`);
    await broadcastProgress(jobId, "info", budgetMsg);

    // Select features (simple — no AI call needed for small apps)
    const selectionResult = selectFeatures(discoveryResults, costEstimate.features_planned);
    features = selectionResult.selected;
    additionalFeatures = selectionResult.additional;

    // Recalculate cost estimate with actual feature count
    costEstimate = estimateCost(
      discoveryResults,
      features.length + additionalFeatures.length,
      userCredits,
    );

    console.log(`[orchestrator] Feature selection complete: ${features.length} selected, ${additionalFeatures.length} additional`);

    // Broadcast feature selection summary
    const selectionSummary = buildFeatureSelectionSummary(selectionResult, costEstimate);
    await broadcastProgress(jobId, "info", selectionSummary);

    // Build feature names list for broadcast
    const featureNames = features.map((f) => f.name).join(", ");
    await broadcastProgress(
      jobId,
      "info",
      `Selected ${features.length} features to document: ${featureNames}`,
    );

    // Store features in job record
    await supabase
      .from("jobs")
      .update({ journeys: features })
      .eq("id", jobId);

    // ═════════════════════════════════════════════════
    // Stage 5: Feature Crawl
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "crawling");
    await broadcastProgress(jobId, "info", "Crawling application features...");

    try {
      const crawlResult = await runCrawl({
        jobId,
        appUrl: typedJob.app_url,
        loginUrl: typedJob.login_url ?? loginUrl ?? undefined,
        credentials: typedJob.credentials ?? undefined,
        features,
        crawlPlan,
        maxScreens: typedJob.config?.max_screens,
      });

      screensCaptured = crawlResult.screens.length;
      console.log(`[orchestrator] Crawl complete: ${screensCaptured} screens, ${crawlResult.errors.length} errors`);

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

      const { count } = await supabase
        .from("screens")
        .select("*", { count: "exact", head: true })
        .eq("job_id", jobId)
        .eq("status", "crawled");

      screensCaptured = count ?? 0;

      if (screensCaptured < 2) {
        await failJob(jobId, `Crawl failed with only ${screensCaptured} screens captured: ${msg}`);
        return;
      }

      console.log(`[orchestrator] Crawl partially failed but ${screensCaptured} screens captured, continuing...`);
      await broadcastProgress(jobId, "info", `Crawl partially failed, continuing with ${screensCaptured} screens`);
    }

    // Check minimum screens
    if (screensCaptured < 2) {
      const { count } = await supabase
        .from("screens")
        .select("*", { count: "exact", head: true })
        .eq("job_id", jobId)
        .eq("status", "crawled");

      screensCaptured = count ?? 0;

      if (screensCaptured < 2) {
        await failJob(jobId, `Only ${screensCaptured} screens captured, need at least 2 for document generation`);
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
        features: features.map((f) => ({ id: f.id, name: f.name, slug: f.slug, description: f.description })),
      });

      console.log(`[orchestrator] Screen analysis complete: ${analysisResult.analyzedScreens}/${analysisResult.totalScreens}, quality: ${analysisResult.qualityScore}%`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] Screen analysis failed:", msg);
      await broadcastProgress(jobId, "error", `Screen analysis failed: ${msg}`);
    }

    // ═════════════════════════════════════════════════
    // Stage 7: Document Generation
    // ═════════════════════════════════════════════════
    await updateJobStatus(jobId, "generating_docs");
    await broadcastProgress(jobId, "info", "Generating documentation...");

    try {
      const mdResult = await runMarkdownGenerator({
        jobId,
        appName,
        appUrl: typedJob.app_url,
        prdSummary,
        features,
      });

      // Calculate actual cost
      const actualCostCents = costEstimate?.estimated_cost_cents ?? 100;

      // Deduct credits
      await deductCredits(typedJob.user_id, jobId, actualCostCents);

      // Update job with final result
      const totalDurationSeconds = Math.round((Date.now() - startTime) / 1000);

      await supabase
        .from("jobs")
        .update({
          status: "completed",
          result: {
            docs_url: `/jobs/${jobId}/docs`,
            zip_url: mdResult.zipUrl,
            total_screens: mdResult.totalScreens,
            avg_confidence: mdResult.avgConfidence,
            duration_seconds: totalDurationSeconds,
            features_documented: features.length,
            features_total: features.length + additionalFeatures.length,
            estimated_cost_cents: costEstimate?.estimated_cost_cents ?? 0,
            actual_cost_cents: actualCostCents,
            additional_features: additionalFeatures,
          },
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId);

      await broadcastProgress(
        jobId,
        "complete",
        `Documentation generated! ${mdResult.totalScreens} screens, ${mdResult.sections.length} sections, ${mdResult.screenshotCount} screenshots. Cost: ${formatCostCents(actualCostCents)}`,
      );

      console.log(`\n[orchestrator] ════════════════════════════════════════`);
      console.log(`[orchestrator] PIPELINE COMPLETE`);
      console.log(`[orchestrator] Duration: ${totalDurationSeconds}s`);
      console.log(`[orchestrator] Screens: ${mdResult.totalScreens}`);
      console.log(`[orchestrator] Screenshots: ${mdResult.screenshotCount}`);
      console.log(`[orchestrator] Quality: ${mdResult.avgConfidence}/5 avg confidence`);
      console.log(`[orchestrator] Cost: ${formatCostCents(actualCostCents)}`);
      console.log(`[orchestrator] Docs: /jobs/${jobId}/docs`);
      console.log(`[orchestrator] Zip: ${mdResult.zipUrl}`);
      console.log(`[orchestrator] ════════════════════════════════════════\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await failJob(jobId, `Document generation failed: ${msg}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failJob(jobId, `Pipeline error: ${msg}`);
    await deleteCredentials(jobId);
  }
}
