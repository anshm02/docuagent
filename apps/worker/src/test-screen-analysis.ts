// Test script for screen analysis engine
import "dotenv/config";
import { getSupabase } from "./lib/supabase.js";
import { claudeVision, parseJsonResponse } from "./lib/claude.js";
import { screenAnalysisPrompt } from "./prompts/screen-analysis.js";
import { runScreenAnalysis } from "./engines/screen-analysis.js";
import type { ScreenAnalysis, Screen } from "@docuagent/shared";

const JOB_ID = "d42dcc5a-d1a8-49be-be98-2e2db5dafb7b";
const APP_NAME = "SaaS Starter";

async function testFirst3Screens() {
  console.log("=== TEST: Analyzing first 3 screens individually ===\n");

  const supabase = getSupabase();
  const { data: screens } = await supabase
    .from("screens")
    .select("*")
    .eq("job_id", JOB_ID)
    .eq("status", "crawled")
    .order("order_index")
    .limit(3);

  if (!screens || screens.length === 0) {
    console.error("No screens found!");
    return;
  }

  for (const screen of screens as Screen[]) {
    console.log(`\n--- Screen ${screen.order_index}: ${screen.nav_path} ---`);
    console.log(`URL: ${screen.url}`);
    console.log(`Screenshot: ${screen.screenshot_url}`);

    if (!screen.screenshot_url) {
      console.log("SKIP: No screenshot URL");
      continue;
    }

    // Fetch screenshot
    const response = await fetch(screen.screenshot_url);
    const buffer = await response.arrayBuffer();
    const imageBase64 = Buffer.from(buffer).toString("base64");

    const prompt = screenAnalysisPrompt({
      appName: APP_NAME,
      domHtml: screen.dom_html ?? "",
      codeContext: screen.code_context,
      prdSummary: null,
      journeyTitle: "Team Settings",
      journeyDescription: "Configure team settings",
      stepNum: screen.journey_step ?? 0,
      navPath: screen.nav_path ?? "",
    });

    console.log(`Calling Claude Vision... (dom: ${screen.dom_html?.length ?? 0} chars)`);

    const raw = await claudeVision(prompt, imageBase64, {
      maxTokens: 2000,
      temperature: 0,
    });

    try {
      const analysis = parseJsonResponse<ScreenAnalysis>(raw);
      console.log("\nScreenAnalysis JSON:");
      console.log(JSON.stringify(analysis, null, 2));

      // Validate
      console.log("\n--- Validation ---");
      console.log(`page_title: ${analysis.page_title ? "OK" : "MISSING"}`);
      console.log(`purpose: ${analysis.purpose ? "OK" : "MISSING"}`);
      console.log(`fields: ${Array.isArray(analysis.fields) ? `${analysis.fields.length} fields` : "MISSING"}`);
      console.log(`actions: ${Array.isArray(analysis.actions) ? `${analysis.actions.length} actions` : "MISSING"}`);
      console.log(`confidence: ${typeof analysis.confidence === "number" ? analysis.confidence : "MISSING"}`);
    } catch (err) {
      console.error("JSON parse failed! Raw response:");
      console.error(raw.slice(0, 500));
      console.error("Error:", err);
    }
  }
}

async function testBatchAll() {
  console.log("\n\n=== TEST: Batch analysis of ALL screens ===\n");

  // First, reset any previously analyzed screens back to crawled for a clean test
  const supabase = getSupabase();
  await supabase
    .from("screens")
    .update({ status: "crawled", analysis: null, confidence: null })
    .eq("job_id", JOB_ID);

  const result = await runScreenAnalysis({
    jobId: JOB_ID,
    appName: APP_NAME,
    prdSummary: null,
    journeys: [
      { id: "j1-team-settings", title: "Team Settings", description: "Configure team settings" },
    ],
  });

  console.log("\n=== BATCH RESULTS ===");
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  try {
    await testFirst3Screens();
    await testBatchAll();
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
}

main();
