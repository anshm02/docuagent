import type { PRDSummary } from "@docuagent/shared";

export function screenAnalysisPrompt(opts: {
  appName: string;
  domHtml: string;
  codeContext: Record<string, unknown> | null;
  prdSummary: PRDSummary | null;
  featureName: string;
  featureDescription: string;
  screenshotLabel: string;
  navPath: string;
}): string {
  const codeSection = opts.codeContext
    ? `\nCODE ANALYSIS (from source code):\n${JSON.stringify(opts.codeContext, null, 2)}`
    : "\nCODE ANALYSIS: Not available for this screen.";

  const prdSection = opts.prdSummary
    ? `\nPRODUCT CONTEXT:\n${JSON.stringify(opts.prdSummary, null, 2)}`
    : "\nPRODUCT CONTEXT: Not available.";

  return `You are a SaaS documentation expert analyzing a screen from "${opts.appName}".

SCREENSHOT: [attached image]

DOM STRUCTURE (truncated):
${opts.domHtml}
${codeSection}
${prdSection}

FEATURE CONTEXT: This is the "${opts.featureName}" feature — ${opts.featureDescription}
SCREENSHOT TYPE: ${opts.screenshotLabel}
NAVIGATION PATH: ${opts.navPath}

Return a JSON object with this exact schema:
{
  "page_title": "string — the title of this page/screen",
  "purpose": "string — one sentence describing what this screen is for",
  "navigation_path": "string — how to get here, e.g. Sidebar → Settings → General",
  "overview_paragraph": "string — 2-3 sentence overview for end-user documentation",
  "fields": [
    {
      "label": "string",
      "type": "string — text, dropdown, checkbox, date, toggle, etc.",
      "required": true/false,
      "description": "string — what this field does, written for end-users",
      "validation": "string — validation rules if any, or empty string",
      "options_note": "string or null — note about dropdown/select options"
    }
  ],
  "actions": [
    {
      "label": "string — button or action text",
      "description": "string — what this action does"
    }
  ],
  "keyboard_shortcuts": [
    {
      "key": "string — e.g. Ctrl+S",
      "action": "string — what it does"
    }
  ],
  "permissions": [
    {
      "action": "string — what requires permission",
      "role": "string — which role can do it"
    }
  ],
  "related_screens": ["string — names of related screens"],
  "workflow_context": "string — how this screen fits in the workflow",
  "tips": ["string — helpful tips for end-users"],
  "troubleshooting": ["string — common issues and solutions"],
  "confidence": 5
}

RULES:
- Use code analysis to confirm field types and validation rules when available
- Use product context to add business meaning to descriptions when available
- If code says a field exists but the screenshot does not show it, note as "conditionally visible"
- Confidence scoring: 5 = full code+PRD match, 4 = screenshot+DOM+partial code, 3 = screenshot+DOM only, 2 = screenshot only with some uncertainty, 1 = very uncertain
- Write descriptions for end-users, not developers
- Include ALL visible fields, buttons, and interactive elements
- If there are no fields, return an empty array for fields
- If there are no keyboard shortcuts, return an empty array

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}
