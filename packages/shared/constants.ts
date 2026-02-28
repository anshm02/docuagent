export const MAX_SCREENS_DEFAULT = 50;
export const SCREENSHOT_WIDTH = 1280;
export const SCREENSHOT_HEIGHT = 800;
export const PAGE_TIMEOUT_MS = 30_000;
export const SETTLE_DELAY_MS = 1000;
export const MODAL_DELAY_MS = 800;
export const CONFIDENCE_THRESHOLD = 4;
export const QUALITY_SCORE_MIN = 60;
export const CONCURRENT_ANALYSIS_BATCH = 3;

// --- Cost Budget System (V2) ---
export const DEFAULT_CREDITS_CENTS = 300; // $3.00
export const COST_FIXED_OVERHEAD_CENTS = 65; // $0.65
export const COST_PER_FEATURE_CENTS = 25; // $0.25 (~2 screenshots × $0.03 analysis + $0.08 prose + $0.06 exploration + $0.05 comparisons)
export const COST_PER_SCREEN_ANALYSIS_CENTS = 3; // $0.03
export const COST_PER_FEATURE_PROSE_CENTS = 8; // $0.08
export const COST_CROSS_CUTTING_CENTS = 10; // $0.10 (only overview now)
export const COST_CODE_ANALYSIS_LOW_CENTS = 30; // $0.30
export const COST_CODE_ANALYSIS_HIGH_CENTS = 90; // $0.90
export const MAX_FREE_TIER_FEATURES = 6;
export const DISCOVERY_TIMEOUT_MS = 45_000; // 45 second per page during discovery
