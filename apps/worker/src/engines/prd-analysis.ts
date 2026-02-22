import { claudeText, parseJsonResponse } from "../lib/claude.js";
import { prdSummaryPrompt } from "../prompts/prd-summary.js";
import type { PRDSummary } from "@docuagent/shared";

const MAX_PRD_CHARS = 40000; // ~10K tokens

export async function runPrdAnalysis(input: {
  prdText?: string | null;
  productDescription?: string | null;
}): Promise<PRDSummary> {
  const { prdText, productDescription } = input;

  const text = prdText || productDescription;
  if (!text) {
    console.log("No PRD or product description provided, returning minimal summary.");
    return {
      product_name: "Unknown Product",
      product_purpose: "No product description available.",
      target_users: [],
      main_features: [],
      key_workflows: [],
      user_roles: [],
      terminology: [],
    };
  }

  console.log(`Analyzing PRD/description (${text.length} chars)...`);

  // Truncate if too long
  const truncated = text.length > MAX_PRD_CHARS
    ? text.substring(0, MAX_PRD_CHARS) + "\n\n[... document truncated for analysis]"
    : text;

  const response = await claudeText(prdSummaryPrompt(truncated), {
    maxTokens: 3000,
    temperature: 0,
  });

  const summary = parseJsonResponse<PRDSummary>(response);

  console.log(`  PRD analysis complete: ${summary.product_name}`);
  console.log(`  Features: ${summary.main_features.length}, Workflows: ${summary.key_workflows.length}, Roles: ${summary.user_roles.length}`);

  return summary;
}
