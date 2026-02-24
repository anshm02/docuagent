import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../../../.env") });

import { getSupabase } from "./lib/supabase.js";

const supabase = getSupabase();

console.log("=== Verifying V2 Migration ===\n");

// Test credits column
const { error: creditsErr } = await supabase.from("profiles").select("credits").limit(1);
console.log(`profiles.credits: ${creditsErr ? `MISSING (${creditsErr.message})` : "OK"}`);

// Test new jobs columns
const cols = ["estimated_cost_cents", "actual_cost_cents", "discovery_data", "code_analysis_summary", "prd_analysis_summary"];
for (const col of cols) {
  const { error } = await supabase.from("jobs").select(col).limit(1);
  console.log(`jobs.${col}: ${error ? `MISSING (${error.message})` : "OK"}`);
}

// Test 'discovering' status is valid
const { error: statusErr } = await supabase.from("jobs").select("id").eq("status", "discovering").limit(1);
console.log(`\nStatus 'discovering' queryable: ${statusErr ? `ERROR (${statusErr.message})` : "OK"}`);

// Test 'generating_docs' status is valid
const { error: statusErr2 } = await supabase.from("jobs").select("id").eq("status", "generating_docs").limit(1);
console.log(`Status 'generating_docs' queryable: ${statusErr2 ? `ERROR (${statusErr2.message})` : "OK"}`);

console.log("\n=== Migration Verification Complete ===");
