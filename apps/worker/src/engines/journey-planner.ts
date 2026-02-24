import { claudeText, parseJsonResponse } from "../lib/claude.js";
import { journeyPlanningPrompt } from "../prompts/journey-planning.js";
import type { CrawlPlan, PRDSummary, DiscoveryResult, Journey, JourneyPlanResult } from "@docuagent/shared";

export async function runJourneyPlanner(
  crawlPlan: CrawlPlan,
  prdSummary: PRDSummary,
  discoveryResults: DiscoveryResult[],
  maxJourneys: number,
): Promise<JourneyPlanResult> {
  console.log("Planning user journeys...");
  console.log(`  Input: ${crawlPlan.routes.length} routes, ${prdSummary.main_features.length} features`);
  console.log(`  Discovery: ${discoveryResults.filter((r) => r.isAccessible).length} accessible pages`);
  console.log(`  Budget: max ${maxJourneys} journeys`);

  const prompt = journeyPlanningPrompt(crawlPlan, prdSummary, discoveryResults, maxJourneys);

  const response = await claudeText(prompt, {
    maxTokens: 4000,
    temperature: 0,
  });

  const result = parseJsonResponse<JourneyPlanResult>(response);

  // Sort planned journeys by priority: creation journeys (priority 1) first
  result.planned.sort((a, b) => a.priority - b.priority);

  console.log(`  Journey planning complete: ${result.planned.length} planned, ${result.additional.length} additional`);
  for (const j of result.planned) {
    console.log(`    [P${j.priority}] ${j.title} (${j.steps.length} steps)`);
  }
  if (result.additional.length > 0) {
    console.log(`  Additional journeys available with upgrade:`);
    for (const a of result.additional) {
      console.log(`    - ${a.title}`);
    }
  }

  return result;
}
