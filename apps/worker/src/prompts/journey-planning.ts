import type { CrawlPlan, PRDSummary, DiscoveryResult } from "@docuagent/shared";

export function journeyPlanningPrompt(
  crawlPlan: CrawlPlan,
  prdSummary: PRDSummary,
  discoveryResults: DiscoveryResult[],
  maxJourneys: number,
): string {
  return `You are planning user journeys for documenting a SaaS application.

BUDGET CONSTRAINT: You may plan at most ${maxJourneys} journeys.

APP ROUTES (from code analysis — shows what pages exist and what they contain):
${JSON.stringify(crawlPlan.routes, null, 2)}

DISCOVERY RESULTS (what the agent actually saw visiting each page):
${JSON.stringify(discoveryResults, null, 2)}

PRODUCT CONTEXT (from PRD — business purpose and workflows):
${JSON.stringify(prdSummary, null, 2)}

Generate exactly ${maxJourneys} user journeys that best showcase the application's core functionality. Prioritize variety — pick journeys that cover DIFFERENT parts of the app.

RULES:
- ONLY include routes that were accessible (isAccessible: true, hasError: false) in discovery results
- NEVER include routes that had errors (hasError: true) in ANY journey — not in planned journeys AND not in additional journeys
- Do NOT suggest journeys that involve pages that were inaccessible or errored during discovery
- Creation journeys FIRST (they populate the app with data)
- Pick journeys that show DIFFERENT features (don't do 3 settings journeys)
- Each journey: 3-6 steps max
- Use code analysis field data to specify realistic test input values
- Use PRD workflows to name and describe journeys in business terms
- Every step must have a target_route (use the actual route paths from APP ROUTES, or "use_navigation" if the route isn't clear)
- captures should list what to screenshot: "page" for full page, "modal:ModalName" for modals
- Set creates_data: true for steps that create/submit new data

Also list other possible journeys you identified but didn't include (as "additional" array with just titles and descriptions). These will be shown to the user as "available with upgrade." IMPORTANT: Only include additional journeys that use routes which were ACCESSIBLE and ERROR-FREE in discovery. Never suggest journeys involving errored or inaccessible pages.

Return JSON:
{
  "planned": [
    {
      "id": "journey-1",
      "title": "Descriptive Journey Title",
      "description": "Brief description",
      "priority": 1,
      "steps": [
        {
          "action": "Human-readable action",
          "target_route": "/route/path",
          "interaction": "Specific interaction or null",
          "captures": ["page"],
          "creates_data": false
        }
      ]
    }
  ],
  "additional": [
    { "title": "Journey Title", "description": "What this journey covers" }
  ]
}

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}
