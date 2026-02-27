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
${opts.featureList.map((f) => `- ${f.name}: ${f.description}`).join("\n")}

${opts.prdSummary ? `PRODUCT CONTEXT (from PRD):\n${JSON.stringify(opts.prdSummary, null, 2)}` : ""}

Return a JSON object:
{
  "product_overview": "2-3 sentences about what the product DOES for the user, not what technology it uses. Focus on user benefits.",
  "feature_descriptions": {
    "${opts.featureList[0]?.slug ?? "example"}": "One line focused on USER BENEFIT. e.g. 'Control who has access to your workspace and what they can do.'"
  }
}

RULES:
- product_overview: What does this product help the user accomplish? Who is it for? 2-3 sentences max.
- feature_descriptions: One entry per feature slug. Each description is ONE sentence focused on the user benefit, not the UI.
  - Good: "Team Management — Control who has access to your workspace and what they can do."
  - Bad: "Team Management — The Dashboard serves as the central hub for monitoring your team's subscription."
- Professional, concise tone
- BANNED phrases: "This page displays", "You'll see", "Here you can", "This is designed to", "serves as the central hub"

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
  "overview": "string — 2-3 sentence product overview suitable for a documentation cover page. Focus on what the product DOES for the user, not what technology it uses."
}

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}
