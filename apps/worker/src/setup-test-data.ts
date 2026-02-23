import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../../../.env") });

import { getSupabase } from "./lib/supabase.js";

async function main() {
  const sb = getSupabase();

  // Create a test user via service role (bypasses auth)
  const testUserId = "11111111-1111-1111-1111-111111111111";

  // First try to create in auth.users via admin API
  const { data: authUser, error: authErr } = await sb.auth.admin.createUser({
    email: "test-crawl@docuagent.test",
    password: "test123456",
    email_confirm: true,
    user_metadata: { display_name: "Test Crawl User" },
  });

  let userId: string;
  if (authErr) {
    console.log("Auth user creation:", authErr.message);
    // Try to get existing user
    const { data: users } = await sb.auth.admin.listUsers();
    const existing = users?.users?.find((u) => u.email === "test-crawl@docuagent.test");
    if (existing) {
      userId = existing.id;
      console.log("Using existing auth user:", userId);
    } else {
      console.error("Cannot create test user!");
      return;
    }
  } else {
    userId = authUser.user.id;
    console.log("Auth user created:", userId);
  }

  // Ensure profile exists
  const { error: profileErr } = await sb.from("profiles").upsert({
    id: userId,
    email: "test-crawl@docuagent.test",
    display_name: "Test Crawl User",
    plan: "free",
  });
  console.log("Profile:", profileErr ? "ERROR: " + profileErr.message : "OK");

  // Create test job
  const { data: job, error: jobErr } = await sb
    .from("jobs")
    .insert({
      user_id: userId,
      app_url: "http://localhost:3000",
      app_name: "SaaS Starter",
      login_url: "http://localhost:3000/sign-in",
      credentials: { username: "test@test.com", password: "admin123" },
      status: "crawling",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobErr) {
    console.log("Job creation:", "ERROR: " + jobErr.message);
  } else {
    console.log("Test job created:", job.id);
    console.log("\nUse this job ID for crawl testing:");
    console.log(`  JOB_ID=${job.id}`);
  }
}

main().catch(console.error);
