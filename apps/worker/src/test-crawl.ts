import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../../../.env") });

import { runCrawl, discoverNavigation } from "./engines/crawl.js";
import { initStagehand, closeStagehand, waitForSettle } from "./lib/stagehand.js";
import { getSupabase } from "./lib/supabase.js";
import type { Journey, CrawlPlan } from "@docuagent/shared";

const JOB_ID = process.env.TEST_JOB_ID || "d42dcc5a-d1a8-49be-be98-2e2db5dafb7b";
const APP_URL = "http://localhost:3000";
const LOGIN_URL = "http://localhost:3000/sign-in";
const USERNAME = "test@test.com";
const PASSWORD = "admin123";

// Simple test journeys for the SaaS Starter app
const testJourneys: Journey[] = [
  {
    id: "j1-team-settings",
    title: "View Team Settings",
    description: "Navigate through the Team Settings area",
    priority: 1,
    steps: [
      {
        action: "Navigate to the dashboard/team settings page",
        target_route: "/dashboard",
        captures: ["page"],
      },
      {
        action: "Click on General in the sidebar",
        target_route: "use_navigation",
        interaction: "Click General in the sidebar navigation",
        captures: ["page"],
      },
      {
        action: "Click on Activity in the sidebar",
        target_route: "use_navigation",
        interaction: "Click Activity in the sidebar navigation",
        captures: ["page"],
      },
      {
        action: "Click on Security in the sidebar",
        target_route: "use_navigation",
        interaction: "Click Security in the sidebar navigation",
        captures: ["page"],
      },
    ],
  },
  {
    id: "j2-invite-member",
    title: "Invite a Team Member",
    description: "Fill the invite form and submit",
    priority: 2,
    steps: [
      {
        action: "Navigate to Team settings to find the Invite Member form",
        target_route: "/dashboard",
        captures: ["page"],
      },
      {
        action: "Fill the Invite Team Member form with a test email",
        target_route: "use_navigation",
        interaction: 'Type "newmember@acme.com" into the email field and click Invite Member',
        captures: ["page"],
        creates_data: true,
      },
    ],
  },
];

const testCrawlPlan: CrawlPlan = {
  framework: "nextjs-app",
  routes: [
    {
      path: "/dashboard",
      component: "page.tsx",
      type: "dashboard",
      fields: [],
      modals: [],
      permissions: [],
      apiCalls: [],
    },
  ],
};

async function testNavDiscovery() {
  console.log("\n=== Test: Nav Discovery Fallback ===\n");
  const { stagehand, page } = await initStagehand();

  await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeoutMs: 30_000 });
  await waitForSettle(page);

  // Login first
  await stagehand.act(`Type "${USERNAME}" into the email input field`, { timeout: 15_000 });
  await stagehand.act(`Type "${PASSWORD}" into the password input field`, { timeout: 15_000 });
  await stagehand.act("Click the sign in button", { timeout: 15_000 });
  await waitForSettle(page);
  await page.waitForTimeout(3000);
  console.log(`Post-login URL: ${page.url()}`);

  // Test nav discovery
  const routes = await discoverNavigation(stagehand, page);
  console.log(`Discovered ${routes.length} navigation routes:`);
  for (const route of routes) {
    console.log(`  - ${route.path} (${route.component})`);
  }

  await closeStagehand();
  console.log("[OK] Nav discovery test complete\n");
  return routes;
}

async function testFullCrawl() {
  console.log("\n=== Test: Full Crawl Execution ===\n");
  console.log(`Job ID: ${JOB_ID}`);
  console.log(`App URL: ${APP_URL}`);
  console.log(`Login URL: ${LOGIN_URL}`);
  console.log(`Journeys: ${testJourneys.length}`);
  console.log(`Total planned steps: ${testJourneys.reduce((sum, j) => sum + j.steps.length, 0)}\n`);

  const result = await runCrawl({
    jobId: JOB_ID,
    appUrl: APP_URL,
    loginUrl: LOGIN_URL,
    credentials: { username: USERNAME, password: PASSWORD },
    journeys: testJourneys,
    crawlPlan: testCrawlPlan,
    maxScreens: 20,
  });

  console.log("\n=== Crawl Results ===");
  console.log(`Total screens captured: ${result.screens.length}`);
  console.log(`Total errors: ${result.errors.length}`);
  console.log(`Duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`);

  console.log("\nScreens:");
  for (const screen of result.screens) {
    console.log(`  [${screen.orderIndex}] ${screen.url}`);
    console.log(`       Type: ${screen.screenType}, Journey: ${screen.journeyId}`);
    console.log(`       Screenshot: ${screen.screenshotUrl ? "✓" : "✗"}`);
    if (screen.createdEntityId) {
      console.log(`       Created entity: ${screen.createdEntityId}`);
    }
  }

  if (result.errors.length > 0) {
    console.log("\nErrors:");
    for (const err of result.errors) {
      console.log(`  [${err.journeyId}/${err.stepIndex}] ${err.action}: ${err.error}`);
    }
  }

  return result;
}

async function verifySupabase() {
  console.log("\n=== Supabase Verification ===\n");
  const sb = getSupabase();

  // Check screens in DB
  const { data: screens, error: screenErr } = await sb
    .from("screens")
    .select("id, url, screenshot_url, screen_type, journey_id, journey_step, status")
    .eq("job_id", JOB_ID);

  if (screenErr) {
    console.log("Screen query error:", screenErr.message);
  } else {
    console.log(`Screens in DB: ${screens?.length || 0}`);
    screens?.forEach((s) => {
      console.log(`  [${s.journey_step}] ${s.url} (${s.screen_type}, ${s.status})`);
      console.log(`       Screenshot URL: ${s.screenshot_url?.slice(0, 80)}...`);
    });
  }

  // Check progress messages
  const { data: messages } = await sb
    .from("progress_messages")
    .select("type, message")
    .eq("job_id", JOB_ID)
    .order("created_at", { ascending: true });

  console.log(`\nProgress messages: ${messages?.length || 0}`);
  messages?.forEach((m) => {
    console.log(`  [${m.type}] ${m.message}`);
  });

  // Check screenshots in storage
  const { data: files } = await sb.storage.from("screenshots").list(`screenshots/${JOB_ID}`);
  console.log(`\nScreenshots in storage: ${files?.length || 0}`);
  files?.forEach((f) => {
    console.log(`  ${f.name} (${f.metadata?.size || "?"} bytes)`);
  });
}

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║       DocuAgent Phase 2: Crawl Engine Test     ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  // Test 1: Nav discovery
  await testNavDiscovery();

  // Test 2: Full crawl with journeys
  const result = await testFullCrawl();

  // Test 3: Verify Supabase data
  await verifySupabase();

  // Summary
  const planned = testJourneys.reduce((sum, j) => sum + j.steps.length, 0);
  const coverage = ((result.screens.length / planned) * 100).toFixed(0);
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log(`║  Coverage: ${result.screens.length}/${planned} screens = ${coverage}%`);
  console.log(`║  Errors: ${result.errors.length}`);
  console.log(`║  Duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  console.log("╚══════════════════════════════════════════════╝");

  if (parseInt(coverage) < 80) {
    console.log("\n⚠️  Coverage below 80% — needs investigation");
  } else {
    console.log("\n✅ Coverage meets target (≥80%)");
  }
}

main().catch((err) => {
  console.error("CRAWL TEST FAILED:", err);
  process.exit(1);
});
