import type { ScreenAnalysis, PRDSummary } from "@docuagent/shared";

export function crossCuttingPrompt(opts: {
  appName: string;
  screenIndex: { pageTitle: string; purpose: string; navigationPath: string }[];
  prdSummary: PRDSummary | null;
}): string {
  return `Given this application overview for "${opts.appName}":

ALL SCREENS:
${JSON.stringify(opts.screenIndex, null, 2)}

${opts.prdSummary ? `PRODUCT CONTEXT:\n${JSON.stringify(opts.prdSummary, null, 2)}` : ""}

Generate cross-cutting documentation content as JSON:
{
  "quick_start": {
    "steps": [
      "string — step-by-step quick start instructions (first login, first key action, etc.)"
    ]
  },
  "navigation_guide": "string — describe the app's navigation structure (sidebar, top nav, main content area). Written as 2-3 paragraphs.",
  "glossary": [
    {
      "term": "string — key term used in the app",
      "definition": "string — clear definition for end-users"
    }
  ],
  "faq": [
    {
      "question": "string — common question about the app",
      "answer": "string — clear, helpful answer"
    }
  ]
}

RULES:
- Quick start should have 3-5 steps that get a new user productive fast
- Navigation guide should describe the actual layout visible in the screenshots
- Glossary should include 5-10 key terms from the app
- FAQ should include 5-8 common questions and answers
- Write everything for end-users, not developers

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
