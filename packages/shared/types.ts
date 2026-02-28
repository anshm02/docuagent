// ============================================================
// DocuAgent — Shared Type Definitions
// ============================================================

// --- Code Analysis (Stage 1) ---

export interface FieldInfo {
  label: string;
  name: string;
  type: string; // text, dropdown, checkbox, date, etc.
  required: boolean;
  validation: string;
  options?: string[];
  defaultValue?: string;
  placeholder?: string;
}

export interface ModalInfo {
  trigger: string; // button text that opens it
  component: string;
  fields: FieldInfo[];
}

export interface RouteInfo {
  path: string; // e.g., "/projects/[id]/settings"
  component: string; // e.g., "ProjectSettings.tsx"
  type: "list" | "detail" | "create" | "settings" | "dashboard" | "other";
  fields: FieldInfo[];
  modals: ModalInfo[];
  permissions: { action: string; role: string }[];
  apiCalls: { method: string; endpoint: string; purpose: string }[];
}

export interface CrawlPlan {
  framework: "nextjs-app" | "nextjs-pages" | "react-router" | "unknown";
  routes: RouteInfo[];
}

// --- PRD Analysis (Stage 2) ---

export interface PRDSummary {
  product_name: string;
  product_purpose: string;
  target_users: string[];
  main_features: { name: string; description: string }[];
  key_workflows: { name: string; steps: string[] }[];
  user_roles: { role: string; description: string }[];
  terminology: { term: string; definition: string }[];
}

// --- Discovery Crawl (Stage 3 — V2) ---

export interface DiscoveryResult {
  route: string;
  actualUrl: string;
  pageTitle: string;
  isAccessible: boolean;
  hasForm: boolean;
  hasTable: boolean;
  hasError: boolean;
  navElements: string[];
  screenshotUrl: string;
  parentCategory?: string; // sidebar parent label, e.g., "Charts" for "Bar Chart"
}

// --- Cost Budget System (V2) ---

export interface CostEstimate {
  screens_estimated: number;
  features_planned: number;
  features_available: number;
  estimated_cost_cents: number;
  user_credits_cents: number;
  features_cut_for_budget: number;
}

// --- Feature Selection (Stage 4) ---

export interface Feature {
  id: string;
  name: string; // sidebar/nav label, e.g., "Team Management"
  slug: string; // kebab-case, e.g., "team-management"
  description: string;
  route: string; // the page URL path (primary page, or first sub-page)
  hasForm: boolean;
  priority: number; // lower = higher priority (sidebar order)
  subPages?: { name: string; route: string }[]; // grouped child pages (e.g., Bar Chart, Line Chart under "Charts")
}

export interface FeatureSelectionResult {
  selected: Feature[];
  additional: { title: string; description: string }[];
}

// --- Screen Analysis (Stage 6) ---

export interface ScreenAnalysis {
  page_title: string;
  purpose: string;
  navigation_path: string;
  overview_paragraph: string;
  fields: {
    label: string;
    type: string;
    required: boolean;
    description: string;
    validation: string;
    options_note?: string;
  }[];
  actions: { label: string; description: string }[];
  keyboard_shortcuts: { key: string; action: string }[];
  permissions: { action: string; role: string }[];
  related_screens: string[];
  workflow_context: string;
  tips: string[];
  troubleshooting: string[];
  confidence: number; // 1-5
}

// --- Document Generation (Stage 7) ---

export interface FeaturePageContent {
  title: string;
  slug: string;
  intro: string;
  action_groups: {
    heading: string;
    steps: {
      action: string;
      detail?: string;
    }[];
    screenshot_ref?: string;
    outcome?: string;
  }[];
  permission_notes: string[];
  fields: {
    label: string;
    type: string;
    required: boolean;
    description: string;
  }[];
  hero_screenshot_ref: string;
  tips?: string[];
}

export interface MarkdownIndexContent {
  product_overview: string;
}

// --- Database Records ---

export type JobStatus =
  | "queued"
  | "analyzing_code"
  | "analyzing_prd"
  | "discovering"
  | "planning_journeys" // DB column name preserved; used for feature selection stage
  | "crawling"
  | "analyzing_screens"
  | "generating_docs"
  | "completed"
  | "failed";

export type ScreenStatus = "discovered" | "crawled" | "analyzed" | "failed";
export type ScreenType = "page" | "modal" | "tab" | "drawer";
export type UserPlan = "free" | "starter" | "pro";
export type ProgressMessageType = "info" | "screenshot" | "question" | "error" | "complete";

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  plan: UserPlan;
  credits: number;
  github_token: string | null;
  created_at: string;
}

export interface Job {
  id: string;
  user_id: string;
  status: JobStatus;
  app_url: string;
  app_name: string | null;
  login_url: string | null;
  credentials: { username: string; password: string } | null;
  github_repo_url: string | null;
  prd_file_path: string | null;
  product_description: string | null;
  config: { max_screens?: number; framework_hint?: string };
  journeys: Feature[] | null; // stores features (DB column name preserved as 'journeys')
  progress: { screens_found?: number; screens_crawled?: number; current_step?: string };
  quality_score: number | null;
  flagged_for_review: boolean;
  result: JobResult | null;
  error: string | null;
  estimated_cost_cents: number | null;
  actual_cost_cents: number | null;
  discovery_data: DiscoveryResult[] | null;
  code_analysis_summary: string | null;
  prd_analysis_summary: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface JobResult {
  docs_url: string;
  zip_url: string;
  total_screens: number;
  avg_confidence: number;
  duration_seconds: number;
  features_documented: number;
  features_total: number;
  estimated_cost_cents: number;
  actual_cost_cents: number;
  additional_features: { title: string; description: string }[];
}

export interface Screen {
  id: string;
  job_id: string;
  url: string;
  route_path: string | null;
  nav_path: string | null;
  screenshot_url: string | null;
  dom_html: string | null;
  code_context: Record<string, unknown> | null;
  prd_context: PRDSummary | null;
  analysis: ScreenAnalysis | null;
  confidence: number | null;
  screen_type: ScreenType;
  journey_id: string | null; // stores feature_id (DB column name preserved)
  journey_step: number | null; // unused in feature-based flow (DB column name preserved)
  created_entity_id: string | null;
  status: ScreenStatus;
  order_index: number | null;
  created_at: string;
}

export interface ProgressMessage {
  id: string;
  job_id: string;
  type: ProgressMessageType;
  message: string;
  screenshot_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
