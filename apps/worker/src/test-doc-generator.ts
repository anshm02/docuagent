// Full end-to-end test for document generation
import "dotenv/config";
import { getSupabase } from "./lib/supabase.js";
import { runDocGenerator } from "./engines/doc-generator.js";
import type { Screen, Journey } from "@docuagent/shared";

const JOB_ID = "d42dcc5a-d1a8-49be-be98-2e2db5dafb7b";
const APP_NAME = "SaaS Starter";

async function main() {
  console.log("=== FULL DOCUMENT GENERATION TEST ===\n");

  const supabase = getSupabase();

  // Verify screens are analyzed
  const { data: screens } = await supabase
    .from("screens")
    .select("id, nav_path, status, confidence, analysis, order_index")
    .eq("job_id", JOB_ID)
    .order("order_index");

  console.log(`Screens in database: ${screens?.length ?? 0}`);
  for (const s of screens ?? []) {
    console.log(`  Screen ${s.order_index}: ${s.nav_path} | status=${s.status} | confidence=${s.confidence}`);
  }

  const analyzedCount = screens?.filter((s) => s.status === "analyzed").length ?? 0;
  if (analyzedCount === 0) {
    console.error("\nERROR: No analyzed screens! Run test-screen-analysis.ts first.");
    process.exit(1);
  }
  console.log(`\nAnalyzed screens: ${analyzedCount}`);

  // Build journeys (since no journeys stored on job)
  const journeys: Journey[] = [
    {
      id: "j1-team-settings",
      title: "Team Settings Configuration",
      description: "Configure your team settings including general information, activity monitoring, and security",
      priority: 1,
      steps: [
        { action: "Navigate to dashboard", target_route: "/dashboard", captures: ["page"] },
        { action: "Click on General", target_route: "/dashboard/general", captures: ["page"] },
        { action: "Click on Activity", target_route: "/dashboard/activity", captures: ["page"] },
        { action: "Click on Security", target_route: "/dashboard/security", captures: ["page"] },
      ],
    },
  ];

  // Run document generation
  console.log("\n--- Running full document generation ---\n");

  const result = await runDocGenerator({
    jobId: JOB_ID,
    appName: APP_NAME,
    prdSummary: null,
    journeys,
  });

  console.log("\n=== GENERATION RESULTS ===");
  console.log(JSON.stringify(result, null, 2));

  // Verify
  console.log("\n=== VERIFICATION ===");
  console.log(`File size: ${result.fileSizeBytes} bytes (${(result.fileSizeBytes / 1024).toFixed(1)} KB)`);
  console.log(`File > 100KB: ${result.fileSizeBytes > 102400 ? "YES" : "NO (may be OK for 5 screens)"}`);
  console.log(`File > 10KB: ${result.fileSizeBytes > 10240 ? "YES" : "NO — PROBLEM"}`);
  console.log(`Screenshots embedded: ${result.screenshotCount}`);
  console.log(`Sections generated: ${result.sections.length}`);
  for (const section of result.sections) {
    console.log(`  - ${section}`);
  }
  console.log(`Average confidence: ${result.avgConfidence}`);
  console.log(`Download URL: ${result.docUrl}`);

  // Verify job was updated in DB
  const { data: job } = await supabase
    .from("jobs")
    .select("status, result, quality_score, completed_at")
    .eq("id", JOB_ID)
    .single();

  console.log("\n=== JOB STATUS ===");
  console.log(`Status: ${job?.status}`);
  console.log(`Quality score: ${job?.quality_score}%`);
  console.log(`Completed at: ${job?.completed_at}`);
  console.log(`Result: ${JSON.stringify(job?.result, null, 2)}`);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
