import type { PRDSummary } from "@docuagent/shared";

export function overviewPrompt(opts: {
  appName: string;
  appUrl: string;
  featureList: { name: string; slug: string; description: string }[];
  prdSummary: PRDSummary | null;
}): string {
  return `Generate a product overview for the "${opts.appName}" documentation index page.

APP URL: ${opts.appUrl}

FEATURES DOCUMENTED:
${JSON.stringify(opts.featureList, null, 2)}

${opts.prdSummary ? `PRODUCT CONTEXT (from PRD):\n${JSON.stringify(opts.prdSummary, null, 2)}` : ""}

Return a JSON object:
{
  "product_overview": "string — 2-3 sentences about what the product does and who it's for. Professional tone. Use PRD context if available."
}

RULES:
- Focus on what the product does and who benefits
- Professional, concise tone
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
