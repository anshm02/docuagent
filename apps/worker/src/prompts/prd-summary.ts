export function prdSummaryPrompt(prdText: string): string {
  return `Analyze this product requirements document. Extract as JSON:
{
  "product_name": "",
  "product_purpose": "one sentence",
  "target_users": [""],
  "main_features": [{ "name": "", "description": "" }],
  "key_workflows": [{ "name": "", "steps": [""] }],
  "user_roles": [{ "role": "", "description": "" }],
  "terminology": [{ "term": "", "definition": "" }]
}

DOCUMENT:
${prdText}

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}
