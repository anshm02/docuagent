import "dotenv/config";
import { getSupabase } from "./lib/supabase.js";

async function main() {
  const supabase = getSupabase();

  // Full job details
  const { data: job } = await supabase.from("jobs").select("*").eq("id", "d42dcc5a-d1a8-49be-be98-2e2db5dafb7b").single();
  if (job) {
    console.log("=== JOB ===");
    console.log(`ID: ${job.id}`);
    console.log(`Status: ${job.status}`);
    console.log(`App: ${job.app_name || job.app_url}`);
    console.log(`GitHub: ${job.github_repo_url}`);
    console.log(`PRD: ${job.prd_file_path}`);
    console.log(`Product Desc: ${job.product_description}`);
    const journeys = job.journeys as { id: string; title: string; description: string; priority: number; steps: unknown[] }[] | null;
    if (journeys) {
      console.log(`\nJourneys (${journeys.length}):`);
      for (const j of journeys) {
        console.log(`  ${j.id}: "${j.title}" (priority ${j.priority}, ${j.steps.length} steps)`);
      }
    }
    console.log(`\nJourneys JSON (full):`);
    console.log(JSON.stringify(journeys, null, 2));
  }

  // All screens with first screenshot URL
  const { data: screens } = await supabase
    .from("screens")
    .select("*")
    .eq("job_id", "d42dcc5a-d1a8-49be-be98-2e2db5dafb7b")
    .order("order_index");

  console.log(`\n=== SCREENS (${screens?.length ?? 0} total) ===`);
  for (const s of screens ?? []) {
    console.log(`\nScreen ${s.order_index}: ${s.nav_path}`);
    console.log(`  id: ${s.id}`);
    console.log(`  url: ${s.url}`);
    console.log(`  screenshot_url: ${s.screenshot_url}`);
    console.log(`  dom_html length: ${s.dom_html?.length ?? 0}`);
    console.log(`  code_context: ${s.code_context ? JSON.stringify(s.code_context).slice(0, 200) : "null"}`);
    console.log(`  prd_context: ${s.prd_context ? "present" : "null"}`);
    console.log(`  journey_id: ${s.journey_id} step: ${s.journey_step}`);
    console.log(`  screen_type: ${s.screen_type}`);
    console.log(`  status: ${s.status}`);
  }
}

main().catch(console.error);
