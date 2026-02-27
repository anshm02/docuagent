import type { ScreenAnalysis } from "@docuagent/shared";

export function featureProsePrompt(opts: {
  featureName: string;
  featureDescription: string;
  screenAnalyses: {
    navPath: string;
    analysis: ScreenAnalysis;
    screenshotRef: string;
    screenshotLabel: string; // e.g., "hero", "invite-form-filled"
    codeContext?: Record<string, unknown> | null;
  }[];
  prdSummary?: {
    product_purpose?: string;
    main_features?: { name: string; description: string }[];
    user_roles?: { role: string; description: string }[];
  } | null;
}): string {
  const analysesJson = opts.screenAnalyses.map((sa) => ({
    navigation_path: sa.navPath,
    screenshot_ref: sa.screenshotRef,
    screenshot_label: sa.screenshotLabel,
    page_title: sa.analysis.page_title,
    purpose: sa.analysis.purpose,
    overview: sa.analysis.overview_paragraph,
    fields: sa.analysis.fields,
    actions: sa.analysis.actions,
    permissions: sa.analysis.permissions,
    tips: sa.analysis.tips,
    code_context: sa.codeContext ?? null,
  }));

  const prdBlock = opts.prdSummary
    ? `\nPRODUCT CONTEXT (from PRD — use for business meaning in the intro):\n${JSON.stringify(opts.prdSummary, null, 2)}`
    : "";

  return `You are writing a single markdown documentation page for the "${opts.featureName}" feature.

FEATURE DESCRIPTION: ${opts.featureDescription}
${prdBlock}

SCREEN ANALYSES (each represents one screenshot of this feature's page):
${JSON.stringify(analysesJson, null, 2)}

Return a JSON object with this exact schema:
{
  "title": "string — the feature name as page title, e.g. 'Team Management'",
  "intro": "string — 2-3 sentences MAX. What this feature does and who uses it. Reference business purpose from PRD if available.",
  "action_groups": [
    {
      "heading": "string — action group name, e.g. 'Invite a Team Member' or 'Manage Roles'",
      "steps": [
        {
          "action": "string — ONE action. Bold UI elements with **double asterisks**. e.g. 'Click **Invite Member**.'",
          "detail": "string or null — optional extra context (max 1 sentence)"
        }
      ],
      "screenshot_ref": "string or null — the screenshot_ref of a relevant screenshot for this action group"
    }
  ],
  "permission_notes": ["string — e.g. 'Only **Owner** role users can invite members.' Include ONLY if permissions data exists."],
  "fields": [
    {
      "label": "string — field label as seen in UI",
      "type": "string — field type (text, email, dropdown, checkbox, etc.)",
      "required": true/false,
      "description": "string — include validation rules from code_context if available"
    }
  ]
}

CRITICAL RULES:
- This page documents ONE feature (one sidebar/nav item). Do NOT mix in content from other features.
- Intro: 2-3 sentences MAX. Reference WHY this feature matters using PRD context.
- action_groups: Group related actions. E.g., for Team Management: "View Members", "Invite a Member", "Manage Roles".
- Each step's "action" must be ONE action. Bold all UI element names: **Button**, **Field Name**, **Menu Item**.
- Each step's "detail" field must be ONE sentence maximum or null.
- fields: ONLY include fields that appear ON THIS FEATURE'S PAGE. Merge code_context validation/types with screen analysis.
- permission_notes: ONLY include if permissions data exists in the screen analyses.
- screenshot_ref in action_groups: Use the screenshot_ref from analyses that shows the relevant action. Use null if no matching screenshot.
- BANNED phrases: "This page displays", "You'll see", "Here you can", "This is designed to", "As shown above", "As you can see"
- Write for end-users, not developers.
- If code_context has field validation rules, include them in the field descriptions.

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}
