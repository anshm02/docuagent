// ============================================================
// DocuAgent — Cost Budget System (V2 — Feature-based)
// Estimates job cost, calculates max features within budget,
// checks credits, deducts after completion.
// ============================================================

import { getSupabase } from "./supabase.js";
import type { CostEstimate, DiscoveryResult } from "@docuagent/shared";
import {
  COST_FIXED_OVERHEAD_CENTS,
  COST_PER_FEATURE_CENTS,
  COST_PER_SCREEN_ANALYSIS_CENTS,
  COST_PER_FEATURE_PROSE_CENTS,
  COST_CROSS_CUTTING_CENTS,
  MAX_FREE_TIER_FEATURES,
} from "@docuagent/shared";

export async function getUserCredits(userId: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("profiles")
    .select("credits")
    .eq("id", userId)
    .single();

  if (error || !data) {
    console.error("[cost-budget] Failed to fetch user credits:", error?.message);
    return 0;
  }

  return data.credits ?? 0;
}

export async function checkUserCredits(userId: string): Promise<{ hasCredits: boolean; credits: number }> {
  const credits = await getUserCredits(userId);
  return { hasCredits: credits > 0, credits };
}

export function estimateCost(
  discoveryResults: DiscoveryResult[],
  totalPossibleFeatures: number,
  userCreditsCents: number,
): CostEstimate {
  const avgScreensPerFeature = 2; // hero + action

  // Calculate max features that fit within budget
  const availableBudget = userCreditsCents - COST_FIXED_OVERHEAD_CENTS;
  let maxFeatures = Math.floor(availableBudget / COST_PER_FEATURE_CENTS);
  maxFeatures = Math.min(maxFeatures, totalPossibleFeatures);
  maxFeatures = Math.max(maxFeatures, 1); // always at least 1
  maxFeatures = Math.min(maxFeatures, MAX_FREE_TIER_FEATURES); // cap for free tier

  const screensEstimated = maxFeatures * avgScreensPerFeature;
  const estimatedCostCents =
    COST_FIXED_OVERHEAD_CENTS +
    (screensEstimated * COST_PER_SCREEN_ANALYSIS_CENTS) +
    (maxFeatures * COST_PER_FEATURE_PROSE_CENTS) +
    COST_CROSS_CUTTING_CENTS;

  const featuresCutForBudget = Math.max(0, totalPossibleFeatures - maxFeatures);

  return {
    screens_estimated: screensEstimated,
    features_planned: maxFeatures,
    features_available: totalPossibleFeatures,
    estimated_cost_cents: estimatedCostCents,
    user_credits_cents: userCreditsCents,
    features_cut_for_budget: featuresCutForBudget,
  };
}

export async function storeEstimatedCost(jobId: string, estimatedCostCents: number): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("jobs")
    .update({ estimated_cost_cents: estimatedCostCents })
    .eq("id", jobId);
  if (error) {
    console.error("[cost-budget] Failed to store estimated cost:", error.message);
  }
}

export async function deductCredits(userId: string, jobId: string, actualCostCents: number): Promise<void> {
  const supabase = getSupabase();

  // Store actual cost on job
  const { error: jobErr } = await supabase
    .from("jobs")
    .update({ actual_cost_cents: actualCostCents })
    .eq("id", jobId);
  if (jobErr) {
    console.error("[cost-budget] Failed to store actual cost:", jobErr.message);
  }

  // Deduct from user credits
  const currentCredits = await getUserCredits(userId);
  const newCredits = Math.max(0, currentCredits - actualCostCents);
  const { error: profileErr } = await supabase
    .from("profiles")
    .update({ credits: newCredits })
    .eq("id", userId);
  if (profileErr) {
    console.error("[cost-budget] Failed to deduct credits:", profileErr.message);
  }

  console.log(`[cost-budget] Deducted ${actualCostCents} cents from user ${userId}. Credits: ${currentCredits} → ${newCredits}`);
}

export function formatCostCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
