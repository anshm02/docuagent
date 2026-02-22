import type { CrawlPlan } from "@docuagent/shared";
import type { PRDSummary } from "@docuagent/shared";

export function journeyPlanningPrompt(crawlPlan: CrawlPlan, prdSummary: PRDSummary): string {
  return `You are planning user journeys for documenting a SaaS application.

APP ROUTES:
${JSON.stringify(crawlPlan.routes, null, 2)}

PRODUCT CONTEXT:
${JSON.stringify(prdSummary, null, 2)}

Generate 5-7 core user journeys that cover the main functionality.

CRITICAL RULES:
- Creation journeys FIRST (priority: 1) — these populate the app with data
- Viewing/editing journeys SECOND (priority: 2) — these need data to exist
- Each journey is a sequence of steps a user would follow
- Include modals, form fills, and confirmations as separate steps
- For creation steps, specify what test data to enter (realistic names like "Acme Corp", not "test123")
- Every step must have a target_route (use the actual route paths from APP ROUTES, or "use_navigation" if the route isn't clear)
- captures should list what to screenshot: "page" for full page, "modal:ModalName" for modals
- Set creates_data: true for steps that create/submit new data

Return as JSON array:
[
  {
    "id": "journey-1",
    "title": "Descriptive Journey Title",
    "description": "Brief description of what this journey covers",
    "priority": 1,
    "steps": [
      {
        "action": "Human-readable action description",
        "target_route": "/actual/route/path",
        "interaction": "Specific interaction description or null",
        "captures": ["page"],
        "creates_data": false
      }
    ]
  }
]

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}
