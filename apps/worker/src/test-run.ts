// ============================================================
// DocuAgent — End-to-end test runner
// Creates a job record in Supabase and runs the full pipeline
// ============================================================

import "dotenv/config";
import { getSupabase } from "./lib/supabase.js";
import { runPipeline } from "./orchestrator.js";
import crypto from "crypto";

async function ensureTestUser(supabase: ReturnType<typeof getSupabase>): Promise<string> {
  const testEmail = "docuagent-test@test.local";

  // Check if user already exists by listing users
  const { data: existingUsers } = await supabase.auth.admin.listUsers();
  const existing = existingUsers?.users?.find((u) => u.email === testEmail);
  if (existing) {
    console.log(`[test] Found existing test user: ${existing.id}`);
    // Ensure profile exists
    await supabase.from("profiles").upsert({
      id: existing.id,
      email: testEmail,
      display_name: "Test User",
      plan: "free",
    });
    return existing.id;
  }

  // Create test user via admin API
  const { data: newUser, error } = await supabase.auth.admin.createUser({
    email: testEmail,
    password: "test-password-123",
    email_confirm: true,
  });

  if (error) {
    throw new Error(`Failed to create test user: ${error.message}`);
  }

  const userId = newUser.user.id;
  console.log(`[test] Created test user: ${userId}`);

  // Create profile
  await supabase.from("profiles").upsert({
    id: userId,
    email: testEmail,
    display_name: "Test User",
    plan: "free",
  });

  return userId;
}

async function main() {
  const startTime = Date.now();

  console.log("╔════════════════════════════════════════════════╗");
  console.log("║   DocuAgent — End-to-End Pipeline Test Run     ║");
  console.log("╚════════════════════════════════════════════════╝\n");

  const supabase = getSupabase();

  // Ensure test user exists
  const userId = await ensureTestUser(supabase);
  const jobId = crypto.randomUUID();

  // Test configuration
  const jobConfig = {
    id: jobId,
    user_id: userId,
    status: "queued",
    app_url: "http://localhost:3000",
    app_name: "SaaS Starter",
    login_url: "http://localhost:3000/sign-in",
    credentials: {
      username: "test@test.com",
      password: "admin123",
    },
    github_repo_url: "https://github.com/nextjs/saas-starter",
    product_description:
      "SaaS Starter is a team management and subscription billing platform. It allows team owners to create organizations, invite members, manage roles, and handle subscription billing. Key features: email/password auth, team management with Owner and Member roles, dashboard with activity logging, general and security settings.",
    config: { max_screens: 50 },
  };

  console.log("Job ID:", jobId);
  console.log("App URL:", jobConfig.app_url);
  console.log("Login URL:", jobConfig.login_url);
  console.log("GitHub repo:", jobConfig.github_repo_url);
  console.log("");

  // Insert job record
  console.log("[test] Creating job record in Supabase...");
  const { error: insertErr } = await supabase.from("jobs").insert(jobConfig);
  if (insertErr) {
    console.error("[test] Failed to create job:", insertErr.message);
    process.exit(1);
  }
  console.log("[test] Job created successfully\n");

  // Run the full pipeline
  await runPipeline(jobId);

  // Fetch final job record
  console.log("\n[test] ═══ Fetching final job record ═══");
  const { data: finalJob, error: fetchErr } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (fetchErr) {
    console.error("[test] Failed to fetch final job:", fetchErr.message);
    process.exit(1);
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);

  console.log("\n╔════════════════════════════════════════════════╗");
  console.log("║              TEST RUN RESULTS                  ║");
  console.log("╠════════════════════════════════════════════════╣");
  console.log(`║ Job ID:           ${jobId}`);
  console.log(`║ Status:           ${finalJob.status}`);
  console.log(`║ Quality Score:    ${finalJob.quality_score ?? "N/A"}%`);
  console.log(`║ Flagged:          ${finalJob.flagged_for_review}`);
  console.log(`║ Total Duration:   ${totalDuration}s`);
  console.log(`║ Error:            ${finalJob.error ?? "None"}`);

  if (finalJob.result) {
    console.log(`║ Doc URL:          ${finalJob.result.doc_url}`);
    console.log(`║ Total Screens:    ${finalJob.result.total_screens}`);
    console.log(`║ Avg Confidence:   ${finalJob.result.avg_confidence}`);
    console.log(`║ Pipeline Duration:${finalJob.result.duration_seconds}s`);
  }

  console.log(`║ Credentials:      ${finalJob.credentials === null ? "DELETED ✓" : "STILL PRESENT ✗"}`);
  console.log("╚════════════════════════════════════════════════╝");

  // Fetch screen count
  const { count: screenCount } = await supabase
    .from("screens")
    .select("*", { count: "exact", head: true })
    .eq("job_id", jobId);

  console.log(`\nScreens in database: ${screenCount}`);

  // Fetch progress messages
  const { data: messages } = await supabase
    .from("progress_messages")
    .select("type, message, created_at")
    .eq("job_id", jobId)
    .order("created_at");

  if (messages && messages.length > 0) {
    console.log(`\nProgress log (${messages.length} messages):`);
    for (const msg of messages) {
      const time = new Date(msg.created_at).toLocaleTimeString();
      console.log(`  [${time}] [${msg.type}] ${msg.message}`);
    }
  }

  if (finalJob.status === "completed") {
    console.log("\n✓ TEST PASSED — Pipeline completed successfully");
  } else {
    console.log("\n✗ TEST FAILED — Pipeline did not complete");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
