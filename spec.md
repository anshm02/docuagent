# DocuAgent — Technical Specification

## What This Is
An autonomous SaaS documentation generator. Customer provides: app URL + credentials, GitHub repo URL (optional), PRD document (optional). DocuAgent crawls the app, analyzes screens with AI, and produces a professional .docx document.

## System Architecture

### Deployment
- **Frontend**: Next.js 14 on Vercel (free tier)
- **Backend + Worker**: Single Node.js process on Railway (~$10/mo). Handles API endpoints AND job processing sequentially. No job queue for MVP.
- **Database/Auth/Storage/Realtime**: Supabase (free → $25/mo)
- **AI**: Anthropic Claude API (Sonnet 4.5)
- **Browser**: Stagehand v3 (self-hosted headless Chromium)

### Data Flow
1. User submits job via Next.js frontend → POST to Railway API
2. Railway validates input, creates job record in Supabase (status: queued)
3. Railway starts processing immediately (same process, no queue)
4. Pipeline runs 6 stages sequentially
5. Final .docx uploaded to Supabase Storage
6. Job status updated to completed with download URL
7. Frontend polls or listens via Supabase Realtime for updates

---

## Database Schema (Supabase PostgreSQL)

### profiles
```sql
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email TEXT NOT NULL,
  display_name TEXT,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro')),
  github_token TEXT, -- encrypted, from GitHub OAuth
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### jobs
```sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) NOT NULL,
  status TEXT DEFAULT 'queued' CHECK (status IN (
    'queued', 'analyzing_code', 'analyzing_prd', 'planning_journeys',
    'crawling', 'analyzing_screens', 'generating_doc', 'completed', 'failed'
  )),
  app_url TEXT NOT NULL,
  app_name TEXT,
  login_url TEXT,
  credentials JSONB, -- { username, password } — deleted after job completes
  github_repo_url TEXT,
  prd_file_path TEXT, -- Supabase Storage path
  product_description TEXT, -- optional free-text context
  config JSONB DEFAULT '{}', -- { max_screens: 50, framework_hint }
  journeys JSONB, -- planned user journeys from Stage 3
  progress JSONB DEFAULT '{}', -- { screens_found, screens_crawled, current_step }
  quality_score INTEGER, -- % of screens with confidence >= 4
  flagged_for_review BOOLEAN DEFAULT false,
  result JSONB, -- { doc_url, total_screens, avg_confidence, duration_seconds }
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### screens
```sql
CREATE TABLE screens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(id) NOT NULL,
  url TEXT NOT NULL,
  route_path TEXT,
  nav_path TEXT, -- e.g., "Sidebar → Projects → Settings"
  screenshot_url TEXT, -- Supabase Storage URL
  dom_html TEXT,
  code_context JSONB, -- { component, fields, validation, permissions, api_calls }
  prd_context JSONB, -- structured PRD summary (same for all screens)
  analysis JSONB, -- Claude Vision output
  confidence INTEGER, -- 1-5
  screen_type TEXT DEFAULT 'page' CHECK (screen_type IN ('page', 'modal', 'tab', 'drawer')),
  journey_id TEXT, -- which journey this belongs to
  journey_step INTEGER,
  created_entity_id TEXT, -- if this screen created data
  status TEXT DEFAULT 'discovered' CHECK (status IN ('discovered', 'crawled', 'analyzed', 'failed')),
  order_index INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### progress_messages
```sql
CREATE TABLE progress_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(id) NOT NULL,
  type TEXT CHECK (type IN ('info', 'screenshot', 'question', 'error', 'complete')),
  message TEXT NOT NULL,
  screenshot_url TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Row Level Security
```sql
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE screens ENABLE ROW LEVEL SECURITY;
ALTER TABLE progress_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own profile" ON profiles FOR ALL USING (auth.uid() = id);
CREATE POLICY "Users see own jobs" ON jobs FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users see own screens" ON screens FOR ALL USING (
  job_id IN (SELECT id FROM jobs WHERE user_id = auth.uid())
);
CREATE POLICY "Users see own messages" ON progress_messages FOR ALL USING (
  job_id IN (SELECT id FROM jobs WHERE user_id = auth.uid())
);
```

---

## Pipeline Stage Details

### Stage 1: Code Analysis (`engines/code-analysis.ts`)

**Input**: GitHub repo URL (or null)
**Output**: CrawlPlan JSON

```typescript
interface CrawlPlan {
  framework: 'nextjs-app' | 'nextjs-pages' | 'react-router' | 'unknown';
  routes: RouteInfo[];
}

interface RouteInfo {
  path: string; // e.g., "/projects/[id]/settings"
  component: string; // e.g., "ProjectSettings.tsx"
  type: 'list' | 'detail' | 'create' | 'settings' | 'dashboard' | 'other';
  fields: FieldInfo[];
  modals: ModalInfo[];
  permissions: { action: string; role: string }[];
  apiCalls: { method: string; endpoint: string; purpose: string }[];
}

interface FieldInfo {
  label: string;
  name: string;
  type: string; // text, dropdown, checkbox, date, etc.
  required: boolean;
  validation: string;
  options?: string[]; // for dropdowns/radios
  defaultValue?: string;
  placeholder?: string;
}

interface ModalInfo {
  trigger: string; // button text that opens it
  component: string;
  fields: FieldInfo[];
}
```

**Process**:
1. GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1
2. Parse package.json → detect framework
3. For Next.js App Router: find all `page.tsx` files in `/app` → map file paths to URL routes
4. For React Router: find router config file → send to Claude for route extraction
5. For each page component: fetch source → send to Claude for component analysis
6. Compile into CrawlPlan

**Fallback**: If no repo provided OR code analysis yields <5 routes, return `{ framework: 'unknown', routes: [] }`. The crawl engine will use Stagehand nav discovery instead.

**Claude prompt for component analysis**:
```
Analyze this React component for documentation purposes.
Extract as JSON:
{
  "fields": [{ "label", "name", "type", "required", "validation", "options", "defaultValue", "placeholder" }],
  "apiCalls": [{ "method", "endpoint", "purpose" }],
  "permissions": [{ "action", "role" }],
  "modals": [{ "trigger", "component", "fields" }],
  "tableColumns": [{ "header", "dataKey" }],
  "actions": [{ "label", "handler_description" }]
}
Only include what you can find in the code. Do not invent fields.
```

### Stage 2: PRD Analysis (`engines/prd-analysis.ts`)

**Input**: PRD file (docx/pdf/txt/md) or product description text
**Output**: PRDSummary JSON

```typescript
interface PRDSummary {
  product_name: string;
  product_purpose: string;
  target_users: string[];
  main_features: { name: string; description: string }[];
  key_workflows: { name: string; steps: string[] }[];
  user_roles: { role: string; description: string }[];
  terminology: { term: string; definition: string }[];
}
```

**Process**:
1. Parse file: mammoth (docx), pdf-parse (pdf), raw read (txt/md)
2. Single Claude call with full text (or first 10K tokens):

```
Analyze this product requirements document. Extract as JSON:
{
  "product_name": "",
  "product_purpose": "one sentence",
  "target_users": [""],
  "main_features": [{ "name": "", "description": "" }],
  "key_workflows": [{ "name": "", "steps": [""] }],
  "user_roles": [{ "role": "", "description": "" }],
  "terminology": [{ "term": "", "definition": "" }]
}
```

### Stage 3: Journey Planning (`engines/journey-planner.ts`)

**Input**: CrawlPlan + PRDSummary
**Output**: Journey[] array

```typescript
interface Journey {
  id: string;
  title: string; // e.g., "Create Your First Project"
  description: string;
  priority: number; // 1 = creation journey (run first), 2 = viewing/editing
  steps: JourneyStep[];
}

interface JourneyStep {
  action: string; // human-readable: "Navigate to Projects page"
  target_route: string; // "/projects" or "use_navigation"
  interaction?: string; // "click 'New Project' button" or "fill form and submit"
  captures: string[]; // what to screenshot: ["page", "modal:CreateProject"]
  creates_data?: boolean; // if this step creates an entity
}
```

**Claude prompt**:
```
You are planning user journeys for documenting a SaaS application.

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

Return as JSON array of Journey objects.
```

### Stage 4: Crawl Execution (`engines/crawl.ts`)

**Stagehand v3 setup**:
```typescript
import { Stagehand } from "@browserbasehq/stagehand";

const stagehand = new Stagehand({
  env: "LOCAL",
  modelName: "claude-sonnet-4-5-20250514",
  modelClientOptions: { apiKey: process.env.ANTHROPIC_API_KEY },
  enableCaching: true,
  headless: true,
});
await stagehand.init();
const page = stagehand.page;
```

**Authentication flow**:
1. `await page.goto(loginUrl)`
2. `await stagehand.observe({ instruction: "Find the email/username and password input fields" })`
3. `await stagehand.act({ action: \`Type "${username}" into the email field\` })`
4. `await stagehand.act({ action: \`Type "${password}" into the password field\` })`
5. `await stagehand.act({ action: "Click the login/sign in button" })`
6. Wait for navigation. Verify login by checking URL changed from login page.
7. If still on login page after 10s: retry once. If fail again: mark job failed.

**Journey execution loop**:
```
for each journey (sorted by priority):
  for each step in journey:
    1. Navigate: page.goto(route) if URL known, else stagehand.act(step.action)
    2. Wait: page.waitForLoadState('networkidle') + 1000ms settle
    3. Screenshot: page.screenshot({ clip: { x:0, y:0, width:1280, height:800 } })
    4. Upload screenshot to Supabase Storage
    5. Extract DOM: page.content() → clean (remove script/style, truncate 4K tokens)
    6. If step.interaction involves form fill:
       - Use code_context fields to generate appropriate test data
       - stagehand.act({ action: "Fill [field] with [value]" }) for each field
       - Screenshot the filled form BEFORE submit
       - stagehand.act({ action: "Click submit/save button" })
       - Screenshot the result AFTER submit
       - Extract created entity ID from URL or page content
    7. If step.captures includes modals:
       - stagehand.act({ action: "Click [trigger button]" })
       - Wait 800ms
       - Screenshot modal
       - stagehand.act({ action: "Close the modal" })
    8. Store screen record in Supabase
    9. Broadcast progress message
```

**Stagehand nav fallback** (when no code analysis):
```typescript
async function discoverNavigation(stagehand: Stagehand): Promise<RouteInfo[]> {
  const navElements = await stagehand.observe({
    instruction: "Find all navigation links in the sidebar, top navigation bar, and any dropdown menus. Return each link's text and URL."
  });
  // Convert observed elements to RouteInfo array
  // Visit each discovered route
}
```

**Error handling**:
- Page timeout (30s): skip, log, continue
- Interaction failure: log, skip interaction, continue with next step
- Session expiry: detect redirect to login, re-authenticate, retry current step
- Duplicate screen (DOM hash >95% match): skip

### Stage 5: Screen Analysis (`engines/screen-analysis.ts`)

**Input per screen**: screenshot (base64 image) + DOM HTML + code_context + prd_summary + journey context
**Output**: ScreenAnalysis JSON

```typescript
interface ScreenAnalysis {
  page_title: string;
  purpose: string;
  navigation_path: string;
  overview_paragraph: string;
  fields: {
    label: string; type: string; required: boolean;
    description: string; validation: string; options_note?: string;
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
```

**Claude Vision prompt**:
```
You are a SaaS documentation expert analyzing a screen from "${appName}".

SCREENSHOT: [attached image]

DOM STRUCTURE (truncated):
${domHtml}

CODE ANALYSIS (from source code):
${JSON.stringify(codeContext)}

PRODUCT CONTEXT:
${JSON.stringify(prdSummary)}

JOURNEY CONTEXT: This screen is step ${stepNum} of "${journeyTitle}" — ${journeyDescription}

Return a JSON object with: page_title, purpose, navigation_path, overview_paragraph,
fields[], actions[], keyboard_shortcuts[], permissions[], related_screens[],
workflow_context, tips[], troubleshooting[], confidence (1-5).

RULES:
- Use code analysis to confirm field types and validation rules
- Use product context to add business meaning to descriptions
- If code says field exists but screenshot doesn't show it, note as "conditionally visible"
- Confidence: 5 = full code+PRD match, 3 = screenshot+DOM only, 1 = uncertain
- Write descriptions for end-users, not developers
```

**Parallel execution**: Process 5 screens concurrently using Promise.all with batching.

### Stage 6: Document Generation (`engines/doc-generator.ts`)

**Phase A: AI Content Generation**

A1 — Journey Guide Prose (per journey):
```
Given these screen analyses for the "${journey.title}" workflow:
${JSON.stringify(journeyScreenAnalyses)}

Write documentation in a clear, professional style:
1. Journey overview (1 paragraph)
2. Step-by-step guide with references to screenshots
3. Tips specific to this workflow
4. Common issues and solutions

Return as JSON: { overview, steps: [{ heading, body, screenshot_ref }], tips[], troubleshooting[] }
```

A2 — Cross-Cutting Content:
```
Given this application overview (all screens summarized):
${compressedIndex}

Generate as JSON:
1. quick_start: { steps: string[] } — first login + first key action + invite team
2. navigation_guide: string — describe the app's navigation structure
3. glossary: { term: string, definition: string }[]
4. faq: { question: string, answer: string }[]
```

A3 — Product Overview:
```
Given this product context:
${JSON.stringify(prdSummary)}

Write a 2-3 sentence product overview for the documentation cover page.
```

**Phase B: Programmatic .docx Assembly** (zero LLM — pure docx npm code)

Document order:
1. Cover page (app name, generation date, DocuAgent branding)
2. Table of contents (auto from Heading styles)
3. Product overview section
4. Quick Start guide
5. Navigation guide
6. Journey guides (PRIMARY) — for each: overview, steps with inline screenshots and field tables
7. Screen Reference appendix (all screens, alphabetical)
8. Glossary
9. FAQ / Troubleshooting
10. Confidence appendix (table: screen, confidence score, notes)

---

## Project Structure

```
docuagent/
├── CLAUDE.md
├── SPEC.md
├── PLAN.md
├── turbo.json
├── package.json
├── tsconfig.base.json
├── apps/
│   ├── web/                          # Next.js frontend
│   │   ├── app/
│   │   │   ├── (auth)/login/page.tsx
│   │   │   ├── dashboard/page.tsx
│   │   │   ├── new/page.tsx          # Job creation form
│   │   │   ├── jobs/[id]/page.tsx    # Progress + download
│   │   │   ├── api/jobs/route.ts     # POST: create job
│   │   │   ├── api/jobs/[id]/route.ts
│   │   │   ├── layout.tsx
│   │   │   └── page.tsx              # Landing page
│   │   ├── components/
│   │   ├── lib/supabase/
│   │   └── package.json
│   │
│   └── worker/                       # Backend + job processor
│       ├── src/
│       │   ├── index.ts              # Express server + job endpoint
│       │   ├── orchestrator.ts       # Pipeline coordinator
│       │   ├── engines/
│       │   │   ├── code-analysis.ts
│       │   │   ├── prd-analysis.ts
│       │   │   ├── journey-planner.ts
│       │   │   ├── crawl.ts
│       │   │   ├── screen-analysis.ts
│       │   │   └── doc-generator.ts
│       │   ├── prompts/
│       │   │   ├── code-analysis.ts
│       │   │   ├── prd-summary.ts
│       │   │   ├── journey-planning.ts
│       │   │   ├── screen-analysis.ts
│       │   │   ├── journey-prose.ts
│       │   │   └── cross-cutting.ts
│       │   ├── doc-components/
│       │   │   ├── design-tokens.ts
│       │   │   ├── components.ts     # h1, h2, p, table, screenshot, callout, etc.
│       │   │   └── templates.ts      # cover, toc, journey-section, appendix
│       │   ├── lib/
│       │   │   ├── supabase.ts
│       │   │   ├── claude.ts         # Anthropic SDK wrapper
│       │   │   ├── github.ts         # GitHub API client
│       │   │   └── stagehand.ts      # Stagehand setup + helpers
│       │   └── test-run.ts           # Manual test script
│       ├── Dockerfile
│       └── package.json
│
├── packages/
│   └── shared/
│       ├── types.ts                  # All TypeScript interfaces
│       └── constants.ts
│
└── supabase/
    ├── migrations/
    │   └── 001_initial_schema.sql
    └── config.toml
```

---

## Environment Variables

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Anthropic
ANTHROPIC_API_KEY=

# GitHub
GITHUB_TOKEN=

# Worker
PORT=3001
NODE_ENV=production
MAX_SCREENS=50
```

---

## Key Dependencies

### Worker (apps/worker/package.json)
```json
{
  "dependencies": {
    "@browserbasehq/stagehand": "^3.0.0",
    "@anthropic-ai/sdk": "latest",
    "docx": "^9.0.0",
    "express": "^4.18.0",
    "@supabase/supabase-js": "^2.0.0",
    "mammoth": "^1.6.0",
    "pdf-parse": "^1.1.1",
    "playwright": "^1.40.0",
    "sharp": "^0.33.0"
  }
}
```

### Web (apps/web/package.json)
```json
{
  "dependencies": {
    "next": "^14.0.0",
    "react": "^18.0.0",
    "@supabase/supabase-js": "^2.0.0",
    "@supabase/ssr": "latest",
    "tailwindcss": "^3.0.0"
  }
}
```