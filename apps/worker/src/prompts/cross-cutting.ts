import type { PRDSummary } from "@docuagent/shared";

export function crossCuttingPrompt(opts: {
  appName: string;
  screenIndex: { pageTitle: string; purpose: string; navigationPath: string }[];
  prdSummary: PRDSummary | null;
}): string {
  return `Generate cross-cutting documentation content for "${opts.appName}".

ALL SCREENS IN THE APP:
${JSON.stringify(opts.screenIndex, null, 2)}

${opts.prdSummary ? `PRODUCT CONTEXT (from PRD):\n${JSON.stringify(opts.prdSummary, null, 2)}` : ""}

Return a JSON object:
{
  "quick_start_steps": [
    "string — 5 steps max. Each step is ONE action. Bold UI elements with **double asterisks**."
  ],
  "navigation_description": "string — 2-3 sentences describing the app layout (sidebar, top nav, main content). Concise.",
  "glossary": [
    {
      "term": "string — key term",
      "definition": "string — 1 sentence definition for end-users"
    }
  ],
  "product_overview": "string — 2-3 sentences about what the product does and who it's for. Use PRD context if available."
}

RULES:
- quick_start_steps: exactly 5 steps. First step is always login. Last step should be a core action.
- navigation_description: describe ONLY what's visible. No speculation.
- glossary: include terms from PRD terminology if available. Only include terms that genuinely need defining. If nothing needs defining, return empty array.
- product_overview: use PRD product_purpose and target_users if available. Professional tone.
- BANNED phrases: "This page displays", "You'll see", "Here you can", "This is designed to"

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}

export function productOverviewPrompt(opts: {
  appName: string;
  prdSummary: PRDSummary | null;
  screenCount: number;
}): string {
  return `Write a product overview for "${opts.appName}" documentation.

${opts.prdSummary ? `PRODUCT CONTEXT:\n${JSON.stringify(opts.prdSummary, null, 2)}` : `This is a SaaS application with ${opts.screenCount} screens documented.`}

Return a JSON object:
{
  "overview": "string — 2-3 sentence product overview suitable for a documentation cover page. Professional tone, focused on what the product does and who it's for."
}

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}
