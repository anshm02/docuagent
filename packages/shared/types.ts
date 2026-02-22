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

// --- Journey Planning (Stage 3) ---

export interface JourneyStep {
  action: string; // human-readable: "Navigate to Projects page"
  target_route: string; // "/projects" or "use_navigation"
  interaction?: string; // "click 'New Project' button" or "fill form and submit"
  captures: string[]; // what to screenshot: ["page", "modal:CreateProject"]
  creates_data?: boolean; // if this step creates an entity
}

export interface Journey {
  id: string;
  title: string; // e.g., "Create Your First Project"
  description: string;
  priority: number; // 1 = creation journey (run first), 2 = viewing/editing
  steps: JourneyStep[];
}

// --- Screen Analysis (Stage 5) ---

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

// --- Document Generation (Stage 6) ---

export interface JourneyProse {
  overview: string;
  steps: { heading: string; body: string; screenshot_ref: string }[];
  tips: string[];
  troubleshooting: string[];
}

export interface CrossCuttingContent {
  quick_start: { steps: string[] };
  navigation_guide: string;
  glossary: { term: string; definition: string }[];
  faq: { question: string; answer: string }[];
}

// --- Database Records ---

export type JobStatus =
  | "queued"
  | "analyzing_code"
  | "analyzing_prd"
  | "planning_journeys"
  | "crawling"
  | "analyzing_screens"
  | "generating_doc"
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
  journeys: Journey[] | null;
  progress: { screens_found?: number; screens_crawled?: number; current_step?: string };
  quality_score: number | null;
  flagged_for_review: boolean;
  result: { doc_url: string; total_screens: number; avg_confidence: number; duration_seconds: number } | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
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
  journey_id: string | null;
  journey_step: number | null;
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
