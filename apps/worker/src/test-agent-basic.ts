// ============================================================
// Basic Stagehand v3 agent() API test
// Verifies agent() works with structured output on a simple page
// ============================================================

import "dotenv/config";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

const PageUnderstandingSchema = z.object({
  purpose: z.string().describe("What is this page for?"),
  userGoals: z.array(z.string()).describe("What can users do here?"),
  pageType: z.enum([
    "dashboard", "form", "table", "chart", "profile", "calendar",
    "settings", "list", "detail", "empty_state", "component_showcase",
    "inbox", "activity_log", "search", "kanban", "editor", "other",
  ]).describe("Type of page"),
  interactionsPerformed: z.array(z.object({
    action: z.string(),
    result: z.string(),
    useful: z.boolean(),
  })).describe("Interactions performed"),
  connectedFeatures: z.array(z.string()),
  hasSubmittableForm: z.boolean(),
  isReadOnly: z.boolean(),
});

async function main() {
  console.log("=== Stagehand v3 Agent Basic Test ===\n");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Missing ANTHROPIC_API_KEY");
    process.exit(1);
  }

  // Check Stagehand version
  try {
    const pkg = await import("@browserbasehq/stagehand/package.json", { with: { type: "json" } });
    console.log(`Stagehand version: ${pkg.default.version}`);
  } catch {
    console.log("Stagehand version: (could not read package.json)");
  }

  const stagehand = new Stagehand({
    env: "LOCAL",
    model: {
      modelName: "anthropic/claude-sonnet-4-6" as const,
      apiKey,
    },
    localBrowserLaunchOptions: {
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
    verbose: 0,
    disablePino: true,
    disableAPI: true,
    experimental: true,
  });

  await stagehand.init();
  const page = await stagehand.context.awaitActivePage();
  console.log("Stagehand initialized ✓\n");

  try {
    // Navigate to a simple public page
    console.log("[test] Navigating to example.com...");
    await page.goto("https://example.com", { waitUntil: "networkidle", timeoutMs: 15000 });
    await page.waitForTimeout(2000);
    console.log(`[test] URL: ${page.url()}`);

    // Take hero screenshot
    const heroBuffer = await page.screenshot({ type: "png" });
    console.log(`[test] Hero: ${heroBuffer.length} bytes\n`);

    // Test agent with structured output
    console.log("[test] Running agent exploration...");
    const agent = stagehand.agent({
      model: "anthropic/claude-sonnet-4-6",
      systemPrompt: "You are a technical writer exploring a web page. Think first, then interact with elements, then report.",
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);

    const startMs = Date.now();
    try {
      const result = await agent.execute({
        instruction: "Explore this page. Understand what it is and what users can do here.",
        maxSteps: 5,
        signal: controller.signal,
        output: PageUnderstandingSchema,
      });
      const elapsed = Date.now() - startMs;

      console.log(`\n[test] Agent completed in ${(elapsed / 1000).toFixed(1)}s`);
      console.log(`[test] Success: ${result.success}`);
      console.log(`[test] Message: ${result.message}`);
      console.log(`[test] Actions: ${result.actions.length}`);

      for (const action of result.actions) {
        console.log(`  [${action.type}] ${action.action || action.reasoning?.slice(0, 80) || ""}`);
      }

      if (result.output) {
        console.log(`\n[test] === Structured Output ===`);
        console.log(JSON.stringify(result.output, null, 2));

        // Verify schema fields present
        const output = result.output as any;
        const checks = [
          ["purpose", typeof output.purpose === "string"],
          ["userGoals", Array.isArray(output.userGoals)],
          ["pageType", typeof output.pageType === "string"],
          ["interactionsPerformed", Array.isArray(output.interactionsPerformed)],
          ["hasSubmittableForm", typeof output.hasSubmittableForm === "boolean"],
          ["isReadOnly", typeof output.isReadOnly === "boolean"],
        ];

        console.log(`\n[test] === Field Verification ===`);
        let allPass = true;
        for (const [name, ok] of checks) {
          console.log(`  ${ok ? "✓" : "✗"} ${name}`);
          if (!ok) allPass = false;
        }

        // Check think tool usage
        const thinkCount = result.actions.filter((a: any) => a.type === "think").length;
        console.log(`\n[test] Think tool used: ${thinkCount > 0 ? `YES ✓ (${thinkCount}x)` : "NO ✗"}`);

        if (allPass) {
          console.log("\n✓ ALL CHECKS PASSED — agent() works with structured output");
        } else {
          console.log("\n✗ SOME CHECKS FAILED");
          process.exit(1);
        }
      } else {
        console.log("\n✗ No structured output returned");
        process.exit(1);
      }
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await stagehand.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
