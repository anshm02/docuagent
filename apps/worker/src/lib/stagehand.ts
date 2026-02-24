import { Stagehand, Page } from "@browserbasehq/stagehand";
import {
  SCREENSHOT_WIDTH,
  SCREENSHOT_HEIGHT,
  SETTLE_DELAY_MS,
} from "@docuagent/shared";

let _stagehand: Stagehand | null = null;

export async function initStagehand(): Promise<{ stagehand: Stagehand; page: Page }> {
  if (_stagehand) {
    await _stagehand.close().catch(() => {});
    _stagehand = null;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY for Stagehand");
  }

  const stagehand = new Stagehand({
    env: "LOCAL",
    model: {
      modelName: "anthropic/claude-sonnet-4-6" as const,
      apiKey,
    },
    localBrowserLaunchOptions: {
      headless: true,
      viewport: { width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT },
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
    verbose: 0,
    disablePino: true,
    disableAPI: true,
  });

  await stagehand.init();

  const page = await stagehand.context.awaitActivePage();
  await page.setViewportSize(SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT, {
    deviceScaleFactor: 1,
  });

  _stagehand = stagehand;
  return { stagehand, page };
}

export async function closeStagehand(): Promise<void> {
  if (_stagehand) {
    await _stagehand.close().catch(() => {});
    _stagehand = null;
  }
}

export async function takeScreenshot(
  page: Page,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  return page.screenshot({
    clip: clip ?? { x: 0, y: 0, width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT },
    type: "png",
  });
}

export async function waitForSettle(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", 10_000);
  } catch {
    // networkidle may not fire — that's ok
  }
  await page.waitForTimeout(SETTLE_DELAY_MS);
}

export async function cleanDom(page: Page, maxTokens = 4000): Promise<string> {
  const html = await page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script, style, svg, noscript, link, meta").forEach((el) => el.remove());
    return clone.innerHTML;
  });
  // Rough token estimate: 1 token ≈ 4 chars
  const maxChars = maxTokens * 4;
  return html.length > maxChars ? html.slice(0, maxChars) : html;
}
