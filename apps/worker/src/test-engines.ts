import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../../../.env") });

import { runCodeAnalysis } from "./engines/code-analysis.js";
import { runPrdAnalysis } from "./engines/prd-analysis.js";
import { runJourneyPlanner } from "./engines/journey-planner.js";
import type { Journey, JourneyPlanResult } from "@docuagent/shared";

const REPO_URL = "https://github.com/nextjs/saas-starter";
const PRODUCT_DESCRIPTION = `
Next.js SaaS Starter is a full-featured SaaS application template built with Next.js 14, Stripe, and Postgres.

Key Features:
- User Authentication: Sign up, sign in, and password management with secure session handling
- Team Management: Create and manage teams, invite members with role-based access (owner/member)
- Subscription & Billing: Stripe integration for subscription plans (Base plan $8/month, Plus plan $12/month)
- Activity Logging: Track all user actions including sign-ins, sign-ups, password changes, account updates, and team member changes
- Dashboard: Central hub for team management and account settings
- Security Settings: Password update functionality with current password verification

User Roles:
- Owner: Full access to team settings, can invite/remove members, manage billing
- Member: Standard access to team features, limited administrative capabilities

Core Workflows:
1. User Registration: Sign up → verify email → set up team → invite members
2. Team Management: Create team → invite members → assign roles → manage permissions
3. Subscription Management: Choose plan → enter payment → manage subscription → upgrade/downgrade
4. Account Security: Update password → review activity log → manage sessions
`;

const errors: string[] = [];
const totalStart = Date.now();

// ============================
// Stage 1: Code Analysis
// ============================
console.log("╔══════════════════════════════════════╗");
console.log("║  Stage 1: Code Analysis              ║");
console.log("╚══════════════════════════════════════╝\n");

let crawlPlan;
try {
  crawlPlan = await runCodeAnalysis(REPO_URL);
  console.log(`\n✓ Routes found: ${crawlPlan.routes.length}`);
  console.log(`  Framework: ${crawlPlan.framework}`);
  for (const route of crawlPlan.routes) {
    const fieldCount = route.fields.length;
    const modalCount = route.modals.length;
    console.log(`  ${route.path} [${route.type}] — ${fieldCount} fields, ${modalCount} modals`);
  }
} catch (error) {
  const msg = `Code analysis failed: ${(error as Error).message}`;
  console.error(msg);
  errors.push(msg);
  crawlPlan = { framework: "unknown" as const, routes: [] };
}

// ============================
// Stage 2: PRD Analysis
// ============================
console.log("\n╔══════════════════════════════════════╗");
console.log("║  Stage 2: PRD Analysis               ║");
console.log("╚══════════════════════════════════════╝\n");

let prdSummary;
try {
  prdSummary = await runPrdAnalysis({ productDescription: PRODUCT_DESCRIPTION });
  console.log(`\n✓ Product: ${prdSummary.product_name}`);
  console.log(`  Purpose: ${prdSummary.product_purpose}`);
  console.log(`  Features: ${prdSummary.main_features.map((f: { name: string }) => f.name).join(", ")}`);
  console.log(`  Workflows: ${prdSummary.key_workflows.length}`);
  console.log(`  Roles: ${prdSummary.user_roles.map((r: { role: string }) => r.role).join(", ")}`);
  console.log(`  Terms: ${prdSummary.terminology.length}`);
} catch (error) {
  const msg = `PRD analysis failed: ${(error as Error).message}`;
  console.error(msg);
  errors.push(msg);
  prdSummary = {
    product_name: "Unknown",
    product_purpose: "",
    target_users: [],
    main_features: [],
    key_workflows: [],
    user_roles: [],
    terminology: [],
  };
}

// ============================
// Stage 3: Journey Planning (V2 — with budget + empty discovery)
// ============================
console.log("\n╔══════════════════════════════════════╗");
console.log("║  Stage 3: Journey Planning           ║");
console.log("╚══════════════════════════════════════╝\n");

let planResult: JourneyPlanResult | null = null;
let journeys: Journey[] = [];
try {
  // V2: pass empty discovery results and max 5 journeys (free tier cap)
  planResult = await runJourneyPlanner(crawlPlan, prdSummary, [], 5);
  journeys = planResult.planned;
  console.log(`\n✓ Journeys planned: ${journeys.length}, additional: ${planResult.additional.length}`);
  for (const j of journeys) {
    console.log(`  [P${j.priority}] "${j.title}" — ${j.steps.length} steps`);
  }
  if (planResult.additional.length > 0) {
    console.log(`  Additional (upgrade): ${planResult.additional.map((a: { title: string }) => a.title).join(", ")}`);
  }

  // Verify creation journeys come first
  const firstPriority2 = journeys.findIndex((j: Journey) => j.priority === 2);
  const lastPriority1 = journeys.map((j: Journey, i: number) => (j.priority === 1 ? i : -1)).filter((i: number) => i >= 0).pop() ?? -1;
  if (firstPriority2 !== -1 && lastPriority1 !== -1 && firstPriority2 < lastPriority1) {
    errors.push("Journey ordering error: priority 2 journey appears before all priority 1 journeys");
  } else {
    console.log("  ✓ Creation journeys (priority 1) ordered first");
  }
} catch (error) {
  const msg = `Journey planning failed: ${(error as Error).message}`;
  console.error(msg);
  errors.push(msg);
}

// ============================
// Summary
// ============================
const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);

console.log("\n╔══════════════════════════════════════╗");
console.log("║  Integration Test Summary            ║");
console.log("╚══════════════════════════════════════╝\n");
console.log(`Total time: ${totalElapsed}s`);
console.log(`Routes found: ${crawlPlan.routes.length}`);
console.log(`PRD product: ${prdSummary.product_name} (${prdSummary.main_features.length} features)`);
console.log(`Journeys: ${journeys.length}`);
if (journeys.length > 0) {
  console.log(`Journey titles: ${journeys.map((j: Journey) => j.title).join(", ")}`);
  console.log(`Total steps: ${journeys.reduce((sum: number, j: Journey) => sum + j.steps.length, 0)}`);
}
if (planResult && planResult.additional.length > 0) {
  console.log(`Additional journeys: ${planResult.additional.length}`);
}

if (errors.length > 0) {
  console.log(`\n✗ Errors (${errors.length}):`);
  for (const e of errors) {
    console.log(`  - ${e}`);
  }
  process.exit(1);
} else {
  console.log("\n✓ All integration tests PASSED!");
}
