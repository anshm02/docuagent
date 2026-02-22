import { claudeText, parseJsonResponse } from "../lib/claude.js";
import { journeyPlanningPrompt } from "../prompts/journey-planning.js";
import type { CrawlPlan, PRDSummary, Journey } from "@docuagent/shared";

export async function runJourneyPlanner(
  crawlPlan: CrawlPlan,
  prdSummary: PRDSummary
): Promise<Journey[]> {
  console.log("Planning user journeys...");
  console.log(`  Input: ${crawlPlan.routes.length} routes, ${prdSummary.main_features.length} features`);

  const response = await claudeText(journeyPlanningPrompt(crawlPlan, prdSummary), {
    maxTokens: 4000,
    temperature: 0,
  });

  const journeys = parseJsonResponse<Journey[]>(response);

  // Sort by priority: creation journeys (priority 1) first
  journeys.sort((a, b) => a.priority - b.priority);

  console.log(`  Journey planning complete: ${journeys.length} journeys`);
  for (const j of journeys) {
    console.log(`    [P${j.priority}] ${j.title} (${j.steps.length} steps)`);
  }

  return journeys;
}
