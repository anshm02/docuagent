import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../../../.env") });

import { initStagehand, closeStagehand, takeScreenshot, waitForSettle, cleanDom } from "./lib/stagehand.js";

async function testStagehandInit() {
  console.log("=== Test 1: Stagehand Initialization + Google Navigation ===\n");

  const { stagehand, page } = await initStagehand();
  console.log("[OK] Stagehand initialized");

  // Navigate to google.com
  await page.goto("https://www.google.com", { waitUntil: "networkidle", timeoutMs: 15_000 });
  await waitForSettle(page);
  const url = page.url();
  console.log(`[OK] Navigated to: ${url}`);

  // Take screenshot
  const screenshot = await takeScreenshot(page);
  const outputPath = resolve("test-screenshots/google.png");
  writeFileSync(outputPath, screenshot);
  console.log(`[OK] Screenshot saved: ${outputPath} (${screenshot.length} bytes)`);

  // Clean DOM
  const dom = await cleanDom(page);
  console.log(`[OK] DOM cleaned: ${dom.length} chars`);

  await closeStagehand();
  console.log("[OK] Stagehand closed\n");
}

async function main() {
  // Ensure test output dir
  const { mkdirSync } = await import("fs");
  mkdirSync(resolve("test-screenshots"), { recursive: true });

  await testStagehandInit();
  console.log("All tests passed!");
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
