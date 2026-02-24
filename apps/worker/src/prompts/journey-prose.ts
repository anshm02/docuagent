import type { ScreenAnalysis } from "@docuagent/shared";

export function journeyProsePrompt(opts: {
  journeyTitle: string;
  journeyDescription: string;
  screenAnalyses: {
    stepNum: number;
    navPath: string;
    analysis: ScreenAnalysis;
    screenshotRef: string;
    codeContext?: Record<string, unknown> | null;
  }[];
  prdSummary?: {
    product_purpose?: string;
    main_features?: { name: string; description: string }[];
    user_roles?: { role: string; description: string }[];
  } | null;
}): string {
  const analysesJson = opts.screenAnalyses.map((sa) => ({
    step_number: sa.stepNum,
    navigation_path: sa.navPath,
    screenshot_ref: sa.screenshotRef,
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

  return `You are writing a single markdown documentation page for the "${opts.journeyTitle}" workflow.

JOURNEY DESCRIPTION: ${opts.journeyDescription}
${prdBlock}

SCREEN ANALYSES (each represents one screen the user sees):
${JSON.stringify(analysesJson, null, 2)}

Return a JSON object with this exact schema:
{
  "title": "string — action-oriented title, e.g. 'Create a New Project'",
  "intro": "string — 2-3 sentences MAX. Reference business purpose from PRD if available. No filler.",
  "how_to_get_there": "string — one sentence, e.g. 'From the sidebar, click **Projects**.'",
  "steps": [
    {
      "action": "string — ONE action. Bold UI elements with **double asterisks**. e.g. 'Click **New Project**.'",
      "detail": "string or null — optional extra context (max 1 sentence)"
    }
  ],
  "permission_notes": ["string — e.g. 'Only **Owner** role users can create projects.' Include ONLY if permissions data exists."],
  "fields": [
    {
      "label": "string — field label as seen in UI",
      "type": "string — field type (text, email, dropdown, checkbox, etc.)",
      "required": true/false,
      "description": "string — include validation rules from code_context if available"
    }
  ],
  "tips": ["string — practical, specific tips. Max 3."],
  "related_slugs": ["string — kebab-case slugs of related journeys if known"]
}

CRITICAL RULES:
- Intro: 2-3 sentences MAX. Reference WHY this workflow matters using PRD context.
- Steps: ONE action per item. Bold all UI element names: **Button**, **Field Name**, **Menu Item**.
- Fields: merge code_context validation/types with screen analysis. Include validation rules like "max 50 characters" or "valid email format".
- Permission notes: ONLY include if permissions data exists in the screen analyses.
- BANNED phrases (never use): "This page displays", "You'll see", "Here you can", "This is designed to", "As shown above", "As you can see"
- Write for end-users, not developers.
- If code_context has field validation rules, include them in the field descriptions.

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}
