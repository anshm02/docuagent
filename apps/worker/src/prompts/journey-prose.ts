import type { ScreenAnalysis } from "@docuagent/shared";

export function journeyProsePrompt(opts: {
  journeyTitle: string;
  journeyDescription: string;
  screenAnalyses: { stepNum: number; navPath: string; analysis: ScreenAnalysis; screenshotRef: string }[];
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
    tips: sa.analysis.tips,
    troubleshooting: sa.analysis.troubleshooting,
  }));

  return `Given these screen analyses for the "${opts.journeyTitle}" workflow:

JOURNEY DESCRIPTION: ${opts.journeyDescription}

SCREEN ANALYSES:
${JSON.stringify(analysesJson, null, 2)}

Write documentation for this workflow in a clear, professional style.

Return a JSON object with this exact schema:
{
  "overview": "string — 1 paragraph overview of this workflow",
  "steps": [
    {
      "heading": "string — step heading, e.g. 'Step 1: Navigate to Settings'",
      "body": "string — detailed instructions for this step. Reference the screenshot using the screenshot_ref value like 'As shown in Figure X'. Include field descriptions and tips inline.",
      "screenshot_ref": "string — the screenshot reference ID for this step"
    }
  ],
  "tips": ["string — workflow-specific tips"],
  "troubleshooting": ["string — common issues and solutions for this workflow"]
}

RULES:
- Write for end-users, not developers
- Be specific about what to click, what to type, where to look
- Reference screenshots naturally in the text (e.g., "as shown in the figure below")
- Include field descriptions within the step body where relevant
- Each step should correspond to one screen/action
- Tips should be practical and specific to this workflow
- Include at least 2 tips and 2 troubleshooting items

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}
