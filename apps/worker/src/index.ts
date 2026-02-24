// ============================================================
// DocuAgent — Worker API Server
// Express server: POST /api/jobs, GET /api/jobs/:id, GET /health
// ============================================================

import "dotenv/config";
import express from "express";
import { getSupabase } from "./lib/supabase.js";
import { runPipeline } from "./orchestrator.js";
import { checkUserCredits, formatCostCents } from "./lib/cost-budget.js";
import { DEFAULT_CREDITS_CENTS } from "@docuagent/shared";
import crypto from "crypto";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3001", 10);

// ---------------------------------------------------------------------------
// Default user helper (for MVP without frontend auth)
// ---------------------------------------------------------------------------

async function getOrCreateDefaultUser(supabase: ReturnType<typeof getSupabase>): Promise<string> {
  const defaultEmail = "docuagent-api@test.local";

  // Check if user exists
  const { data: existingUsers } = await supabase.auth.admin.listUsers();
  const existing = existingUsers?.users?.find((u) => u.email === defaultEmail);
  if (existing) return existing.id;

  // Create user
  const { data: newUser, error } = await supabase.auth.admin.createUser({
    email: defaultEmail,
    password: "api-default-password",
    email_confirm: true,
  });

  if (error) throw new Error(`Failed to create default user: ${error.message}`);

  // Create profile with default credits
  await supabase.from("profiles").upsert({
    id: newUser.user.id,
    email: defaultEmail,
    display_name: "API Default User",
    plan: "free",
    credits: DEFAULT_CREDITS_CENTS,
  });

  return newUser.user.id;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json({ limit: "10mb" }));

// CORS
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "docuagent-worker",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs — Create a new documentation job
// ---------------------------------------------------------------------------

app.post("/api/jobs", async (req, res) => {
  try {
    const {
      app_url,
      app_name,
      login_url,
      credentials,
      github_repo_url,
      product_description,
      config,
      user_id,
    } = req.body;

    // Validate required fields
    if (!app_url) {
      res.status(400).json({ error: "app_url is required" });
      return;
    }

    // Validate URL format
    try {
      new URL(app_url);
    } catch {
      res.status(400).json({ error: "app_url must be a valid URL" });
      return;
    }

    if (login_url) {
      try {
        new URL(login_url);
      } catch {
        res.status(400).json({ error: "login_url must be a valid URL" });
        return;
      }
    }

    if (github_repo_url) {
      try {
        new URL(github_repo_url);
      } catch {
        res.status(400).json({ error: "github_repo_url must be a valid URL" });
        return;
      }
    }

    // Create job record in Supabase
    const supabase = getSupabase();
    const jobId = crypto.randomUUID();

    // Resolve user_id: use provided, or create/find a default test user
    let resolvedUserId = user_id;
    if (!resolvedUserId) {
      resolvedUserId = await getOrCreateDefaultUser(supabase);
    }

    // Check user has credits before starting
    const { hasCredits, credits } = await checkUserCredits(resolvedUserId);
    if (!hasCredits) {
      res.status(402).json({
        error: "No credits remaining. Please upgrade your plan to continue generating documentation.",
        credits: 0,
      });
      return;
    }
    console.log(`[api] User credits: ${formatCostCents(credits)}`);

    const { error: insertErr } = await supabase.from("jobs").insert({
      id: jobId,
      user_id: resolvedUserId,
      status: "queued",
      app_url,
      app_name: app_name ?? null,
      login_url: login_url ?? null,
      credentials: credentials ?? null,
      github_repo_url: github_repo_url ?? null,
      product_description: product_description ?? null,
      config: config ?? {},
    });

    if (insertErr) {
      console.error("[api] Failed to create job:", insertErr.message);
      res.status(500).json({ error: `Failed to create job: ${insertErr.message}` });
      return;
    }

    console.log(`[api] Created job ${jobId}, starting pipeline...`);

    // Start pipeline async (don't await — return immediately)
    runPipeline(jobId).catch((err) => {
      console.error(`[api] Pipeline error for ${jobId}:`, err);
    });

    res.status(201).json({
      id: jobId,
      status: "queued",
      message: "Job created and processing started",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api] POST /api/jobs error:", msg);
    res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api/jobs/:id — Get job status, progress, and result
// ---------------------------------------------------------------------------

app.get("/api/jobs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();

    const { data: job, error } = await supabase
      .from("jobs")
      .select("id, status, app_url, app_name, progress, quality_score, flagged_for_review, result, error, estimated_cost_cents, actual_cost_cents, code_analysis_summary, prd_analysis_summary, discovery_data, journeys, started_at, completed_at, created_at")
      .eq("id", id)
      .single();

    if (error || !job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Also fetch recent progress messages
    const { data: messages } = await supabase
      .from("progress_messages")
      .select("type, message, screenshot_url, created_at")
      .eq("job_id", id)
      .order("created_at", { ascending: false })
      .limit(100);

    res.json({
      ...job,
      progress_messages: messages ?? [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api] GET /api/jobs/:id error:", msg);
    res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[docuagent-worker] Server running on port ${PORT}`);
  console.log(`[docuagent-worker] Health: http://localhost:${PORT}/health`);
  console.log(`[docuagent-worker] API: http://localhost:${PORT}/api/jobs`);
});
