import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { writeFileSync, mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../../../.env") });

import { initStagehand, closeStagehand, takeScreenshot, waitForSettle } from "./lib/stagehand.js";

async function testAuth() {
  console.log("=== Test: Authentication against localhost:3000 ===\n");
  mkdirSync(resolve("test-screenshots"), { recursive: true });

  const { stagehand, page } = await initStagehand();
  console.log("[OK] Stagehand initialized\n");

  // Step 1: Navigate to login page
  const loginUrl = "http://localhost:3000/sign-in";
  console.log(`[1] Navigating to ${loginUrl}...`);
  await page.goto(loginUrl, { waitUntil: "networkidle", timeoutMs: 30_000 });
  await waitForSettle(page);
  console.log(`[1] Current URL: ${page.url()}`);

  // Take screenshot of login page
  const loginScreenshot = await takeScreenshot(page);
  writeFileSync(resolve("test-screenshots/login-page.png"), loginScreenshot);
  console.log(`[1] Login page screenshot: ${loginScreenshot.length} bytes\n`);

  // Step 2: Fill credentials and submit
  console.log("[2] Filling in credentials...");
  try {
    await stagehand.act(
      'Type "test@test.com" into the email or username input field',
      { timeout: 15_000 },
    );
    console.log("[2] Email entered");

    await stagehand.act(
      'Type "admin123" into the password input field',
      { timeout: 15_000 },
    );
    console.log("[2] Password entered");

    // Screenshot with credentials filled
    const filledScreenshot = await takeScreenshot(page);
    writeFileSync(resolve("test-screenshots/login-filled.png"), filledScreenshot);
    console.log(`[2] Filled form screenshot: ${filledScreenshot.length} bytes`);

    await stagehand.act("Click the sign in, log in, sign up, or submit button", {
      timeout: 15_000,
    });
    console.log("[2] Submit button clicked\n");
  } catch (err) {
    console.error("[2] FAILED to fill form:", err);

    // Let's see what the page looks like
    const errScreenshot = await takeScreenshot(page);
    writeFileSync(resolve("test-screenshots/login-error.png"), errScreenshot);
    console.log("[2] Error screenshot saved");
  }

  // Step 3: Wait for navigation and check result
  console.log("[3] Waiting for post-login navigation...");
  await waitForSettle(page);
  await page.waitForTimeout(3000);

  const postLoginUrl = page.url();
  console.log(`[3] Post-login URL: ${postLoginUrl}`);

  // Screenshot post-login
  const dashboardScreenshot = await takeScreenshot(page);
  writeFileSync(resolve("test-screenshots/post-login.png"), dashboardScreenshot);
  console.log(`[3] Post-login screenshot: ${dashboardScreenshot.length} bytes\n`);

  // Verify login succeeded
  const loginPatterns = ["/login", "/sign-in", "/signin", "/sign-up", "/signup", "/auth"];
  const stillOnLogin = loginPatterns.some((p) => postLoginUrl.toLowerCase().includes(p));

  if (stillOnLogin) {
    console.log("[WARN] Might still be on login page. Let's check page content...");
    // Try to observe what's on the page
    const content = await stagehand.extract();
    console.log("[3] Page text:", JSON.stringify(content).slice(0, 500));
  } else {
    console.log("[OK] Login appears successful — navigated away from login page!");
  }

  await closeStagehand();
  console.log("\n[OK] Test complete");
}

testAuth().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
