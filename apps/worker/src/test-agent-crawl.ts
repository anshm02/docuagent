// ============================================================
// DocuAgent — Agent crawl engine test
// Tests the new Stagehand v3 agent()-based crawl on a live page
// ============================================================

import "dotenv/config";
import { Stagehand, Page } from "@browserbasehq/stagehand";
import { z } from "zod";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Schemas (same as in crawl.ts)
// ---------------------------------------------------------------------------

const PageUnderstandingSchema = z.object({
  purpose: z.string().describe("1-2 sentences: what is this page for?"),
  userGoals: z.array(z.string()).describe("2-4 things a user would come to this page to accomplish"),
  pageType: z.enum([
    "dashboard", "form", "table", "chart", "profile", "calendar",
    "settings", "list", "detail", "empty_state", "component_showcase",
    "inbox", "activity_log", "search", "kanban", "editor", "other",
  ]).describe("The type of page"),
  interactionsPerformed: z.array(z.object({
    action: z.string().describe("What I did"),
    result: z.string().describe("What happened"),
    useful: z.boolean().describe("Did this change the page visually?"),
  })).describe("Interactions I performed"),
  connectedFeatures: z.array(z.string()).describe("Other app features this page relates to"),
  hasSubmittableForm: z.boolean().describe("Is there a form with a safe submit button?"),
  isReadOnly: z.boolean().describe("Is this page purely informational with no meaningful interactions?"),
});

// ---------------------------------------------------------------------------
// Utility functions (same as in crawl.ts)
// ---------------------------------------------------------------------------

function isScreenshotDifferent(a: Buffer, b: Buffer): boolean {
  if (Math.abs(a.length - b.length) > 5000) return true;
  const midA = Math.floor(a.length / 2);
  const midB = Math.floor(b.length / 2);
  const rangeA = Math.min(2000, Math.floor(a.length / 4));
  const rangeB = Math.min(2000, Math.floor(b.length / 4));
  const sampleA = a.slice(midA - rangeA, midA + rangeA).toString("hex");
  const sampleB = b.slice(midB - rangeB, midB + rangeB).toString("hex");
  return sampleA !== sampleB;
}

function hashScreenshot(buffer: Buffer): string {
  const mid = Math.floor(buffer.length / 2);
  const range = Math.min(1000, Math.floor(buffer.length / 4));
  const sample = buffer.slice(mid - range, mid + range);
  return crypto.createHash("md5").update(sample).digest("hex");
}

async function isPageLoading(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const d = (globalThis as any).document;
      const body = d.body;
      const selectors = [
        '[class*="loading"]', '[class*="spinner"]', '[class*="skeleton"]',
        '[class*="Loading"]', '[class*="Spinner"]',
        '.animate-pulse', '.animate-spin',
        '[role="progressbar"]', '[aria-busy="true"]',
      ];
      for (const sel of selectors) {
        const el = d.querySelector(sel);
        if (el && el.offsetHeight > 0 && el.offsetWidth > 0) return true;
      }
      const text = body.innerText?.trim() || "";
      if (text.length < 50) return true;
      return false;
    });
  } catch { return false; }
}

function isOnSamePage(current: string, expected: string): boolean {
  try {
    const c = new URL(current);
    const e = new URL(expected);
    return c.host === e.host && c.pathname === e.pathname;
  } catch { return true; }
}

// ---------------------------------------------------------------------------
// Test: Agent explores a localhost SaaS app
// ---------------------------------------------------------------------------

async function testAgentCrawl() {
  const appUrl = "http://localhost:3000";
  const loginUrl = "http://localhost:3000/sign-in";
  const username = "test@test.com";
  const password = "admin123";

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  DocuAgent — Agent Crawl Engine Test             ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log(`Stagehand v3 with agent() method`);
  console.log(`App URL: ${appUrl}`);
  console.log(`Login: ${loginUrl}\n`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Missing ANTHROPIC_API_KEY");
    process.exit(1);
  }

  // ---- Step 1: Print Stagehand version ----
  const stagehandPkg = await import("@browserbasehq/stagehand/package.json", { with: { type: "json" } }).catch(() => null);
  console.log(`Stagehand version: ${stagehandPkg?.default?.version ?? "unknown"}`);

  // ---- Step 2: Initialize Stagehand ----
  console.log("\n[test] Initializing Stagehand...");
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
  await page.setViewportSize(1280, 800, { deviceScaleFactor: 1 });
  console.log("[test] Stagehand initialized ✓\n");

  try {
    // ---- Step 3: Login ----
    console.log("[test] === Login ===");
    await page.goto(loginUrl, { waitUntil: "networkidle", timeoutMs: 30000 });
    await page.waitForTimeout(2000);

    await stagehand.act(`Type "${username}" into the email or username input field`, { timeout: 15000 });
    await stagehand.act(`Type "${password}" into the password input field`, { timeout: 15000 });
    await stagehand.act("Click the sign in, log in, or submit button", { timeout: 15000 });
    await page.waitForTimeout(3000);
    console.log(`[test] Post-login URL: ${page.url()}`);

    // ---- Step 4: Navigate to dashboard and take hero screenshot ----
    console.log("\n[test] === Feature: Dashboard ===");
    const featureUrl = `${appUrl}/dashboard`;
    await page.goto(featureUrl, { waitUntil: "networkidle", timeoutMs: 30000 });
    await page.evaluate(() => (globalThis as any).window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 3000));

    // Dismiss overlays
    try {
      await stagehand.act("Close any cookie banner, popup, notification, or overlay blocking the main content", { timeout: 5000 });
    } catch { /* no overlay */ }

    // Loading retry
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await isPageLoading(page)) break;
      console.log(`[test] Loading detected (attempt ${attempt + 1}/3). Waiting 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }

    const heroBuffer = await page.screenshot({ type: "png" });
    const heroHash = hashScreenshot(heroBuffer);
    console.log(`[test] Hero screenshot: ${heroBuffer.length} bytes, hash: ${heroHash}`);
    console.log(`[test] Hero: loading=${await isPageLoading(page)}`);

    // ---- Step 5: Agent exploration ----
    console.log("\n[test] === Agent Exploration ===");
    const allCapturedHashes = new Set<string>([heroHash]);

    const agent = stagehand.agent({
      model: "anthropic/claude-sonnet-4-6",
      systemPrompt: `You are a senior technical writer exploring a web application page to create documentation.

YOUR TOOLS:
- think: ALWAYS use this first to reason about what you see before acting
- act: Perform a single action (click, type, select)
- fillForm: Fill all form fields at once with realistic data
- extract: Get structured data from the page
- scroll: Scroll to see more content
- wait: Wait for loading/animations to finish
- screenshot: Take a screenshot
- navback: Go back if you navigated away

WORKFLOW FOR EVERY PAGE:
1. First, THINK about what you see
2. If loading spinner/skeleton, WAIT 3-5 seconds
3. Interact with documentation-worthy elements (forms, modals, tabs, filters)
4. NEVER interact with header search, sidebar nav, global elements
5. NEVER click Delete, Remove, Send, Invite, Share, or Pay buttons
6. Maximum 8 actions per page`,
    });

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort("Timeout"), 180000); // 3 minutes for real app

    let understanding: any = null;
    const startMs = Date.now();
    try {
      const result = await agent.execute({
        instruction: 'Explore the "Dashboard" page. Understand its purpose, interact with its key elements, and report what you found and did.',
        maxSteps: 10,
        signal: timeout.signal,
        output: PageUnderstandingSchema,
        callbacks: {
          onStepFinish: ({ text, toolCalls }) => {
            const toolNames = toolCalls?.map((t: any) => t.toolName || t.type || "unknown").join(", ") || "none";
            console.log(`  [step] tools: ${toolNames}`);
          },
        },
      });
      const agentMs = Date.now() - startMs;

      understanding = result.output;
      console.log(`\n[test] Agent completed in ${(agentMs / 1000).toFixed(1)}s`);
      console.log(`[test] Success: ${result.success}`);
      console.log(`[test] Message: ${result.message}`);
      console.log(`[test] Actions: ${result.actions.length}`);

      // Print actions
      for (const action of result.actions) {
        const reasoning = action.reasoning ? ` (${action.reasoning.slice(0, 100)})` : "";
        console.log(`  [${action.type}] ${action.action || ""}${reasoning}`);
      }

      if (understanding) {
        console.log(`\n[test] === Structured Output ===`);
        console.log(`  Purpose: ${understanding.purpose}`);
        console.log(`  Page type: ${understanding.pageType}`);
        console.log(`  User goals: ${understanding.userGoals?.join(", ")}`);
        console.log(`  Interactions performed: ${understanding.interactionsPerformed?.length}`);
        for (const i of understanding.interactionsPerformed || []) {
          console.log(`    - ${i.action} → ${i.result} (useful: ${i.useful})`);
        }
        console.log(`  Connected features: ${understanding.connectedFeatures?.join(", ")}`);
        console.log(`  Has submittable form: ${understanding.hasSubmittableForm}`);
        console.log(`  Is read-only: ${understanding.isReadOnly}`);
      }

      // Check think tool usage
      const thinkActions = result.actions.filter((a: any) => a.type === "think");
      console.log(`\n[test] Think tool used: ${thinkActions.length > 0 ? "YES ✓" : "NO ✗"} (${thinkActions.length} times)`);
    } catch (err: any) {
      console.log(`[test] Agent error: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    // ---- Step 6: Post-exploration screenshot verification ----
    console.log("\n[test] === Post-Exploration Screenshot ===");
    const currentUrl = page.url();
    if (!isOnSamePage(currentUrl, featureUrl)) {
      console.log(`[test] Agent navigated away to: ${currentUrl}. Going back.`);
      await page.goto(featureUrl, { waitUntil: "networkidle", timeoutMs: 15000 });
      await new Promise((r) => setTimeout(r, 3000));
    }

    const postBuffer = await page.screenshot({ type: "png" });
    const loading = await isPageLoading(page);
    const different = !loading && isScreenshotDifferent(heroBuffer, postBuffer);
    const postHash = hashScreenshot(postBuffer);
    const duplicate = allCapturedHashes.has(postHash);

    console.log(`[test] Post screenshot: ${postBuffer.length} bytes, hash: ${postHash}`);
    console.log(`[test] Loading: ${loading}, Different: ${different}, Duplicate: ${duplicate}`);
    console.log(`[test] Action screenshot: ${!loading && different && !duplicate ? "CAPTURED ✓" : "SKIPPED ✗"}`);

    // ---- Step 7: Form submission test (if applicable) ----
    if (understanding?.hasSubmittableForm && !understanding?.isReadOnly) {
      console.log("\n[test] === Form Submission ===");
      await page.goto(featureUrl, { waitUntil: "networkidle", timeoutMs: 15000 });
      await new Promise((r) => setTimeout(r, 3000));

      const submitAgent = stagehand.agent({
        model: "anthropic/claude-sonnet-4-6",
        systemPrompt: "You fill forms and submit them. Use realistic data. Never send messages, delete data, or make payments.",
      });

      const submitTimeout = new AbortController();
      const submitTimer = setTimeout(() => submitTimeout.abort(), 60000);

      try {
        const submitResult = await submitAgent.execute({
          instruction: "Fill all form fields with realistic data, then click the Save/Submit/Create button. If no safe submit button exists, do nothing.",
          maxSteps: 8,
          signal: submitTimeout.signal,
        });
        console.log(`[test] Submit result: ${submitResult.message}`);
        await new Promise((r) => setTimeout(r, 3000));

        const resultBuffer = await page.screenshot({ type: "png" });
        const resultHash = hashScreenshot(resultBuffer);
        const resultDiff = isScreenshotDifferent(heroBuffer, resultBuffer);
        console.log(`[test] Result screenshot: ${resultBuffer.length} bytes, hash: ${resultHash}, different: ${resultDiff}`);
      } catch (err: any) {
        console.log(`[test] Submit error: ${err.message}`);
      } finally {
        clearTimeout(submitTimer);
      }
    } else {
      console.log(`\n[test] === Form Submission: SKIPPED (no submittable form or read-only) ===`);
    }

    // ---- Summary ----
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║              TEST RESULTS                        ║");
    console.log("╠══════════════════════════════════════════════════╣");
    console.log(`║ Stagehand v3 agent(): ${understanding ? "YES ✓" : "NO ✗"}`);
    console.log(`║ Structured output:    ${understanding ? "YES ✓" : "NO ✗"}`);
    console.log(`║ Purpose:              ${understanding?.purpose?.slice(0, 50) || "N/A"}`);
    console.log(`║ Page type:            ${understanding?.pageType || "N/A"}`);
    console.log(`║ Goals extracted:      ${understanding?.userGoals?.length || 0}`);
    console.log(`║ Interactions:         ${understanding?.interactionsPerformed?.length || 0}`);
    console.log(`║ Loading detected:     ${loading ? "YES ✗" : "NO ✓"}`);
    console.log(`║ Screenshots differ:   ${different ? "YES ✓" : "NO"}`);
    console.log("╚══════════════════════════════════════════════════╝");
  } finally {
    await stagehand.close().catch(() => {});
  }
}

testAgentCrawl().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
