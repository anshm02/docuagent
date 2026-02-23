import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../../../.env") });

import { getSupabase } from "./lib/supabase.js";

async function main() {
  const sb = getSupabase();

  // Check if tables exist
  const { data: jobs, error: jobErr } = await sb.from("jobs").select("id").limit(1);
  console.log("Jobs table:", jobErr ? "ERROR: " + jobErr.message : `OK (${jobs?.length || 0} rows)`);

  const { data: screens, error: screenErr } = await sb.from("screens").select("id").limit(1);
  console.log("Screens table:", screenErr ? "ERROR: " + screenErr.message : `OK (${screens?.length || 0} rows)`);

  const { data: progress, error: progErr } = await sb.from("progress_messages").select("id").limit(1);
  console.log("Progress table:", progErr ? "ERROR: " + progErr.message : `OK (${progress?.length || 0} rows)`);

  // Check storage buckets
  const { data: buckets, error: bucketErr } = await sb.storage.listBuckets();
  console.log("Storage buckets:", bucketErr ? "ERROR: " + bucketErr.message : JSON.stringify(buckets?.map((b) => b.name)));

  // Create screenshots bucket if missing
  if (!buckets?.find((b) => b.name === "screenshots")) {
    console.log("Creating 'screenshots' bucket...");
    const { error: createErr } = await sb.storage.createBucket("screenshots", { public: true });
    console.log(createErr ? "ERROR: " + createErr.message : "OK — bucket created");
  }

  // Create a test job for crawl testing
  const { data: testJob, error: testJobErr } = await sb
    .from("jobs")
    .insert({
      user_id: "00000000-0000-0000-0000-000000000000",
      app_url: "http://localhost:3000",
      app_name: "SaaS Starter",
      login_url: "http://localhost:3000/sign-in",
      status: "crawling",
    })
    .select("id")
    .single();

  if (testJobErr) {
    console.log("Test job creation:", "ERROR: " + testJobErr.message);
    // Try without user_id constraint
    const { data: existingJobs } = await sb.from("jobs").select("id").limit(1);
    if (existingJobs?.length) {
      console.log("Using existing job:", existingJobs[0].id);
    }
  } else {
    console.log("Test job created:", testJob.id);
  }
}

main().catch(console.error);
