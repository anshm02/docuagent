# DocuAgent V2 Build Plan

Check off each task as completed. Claude: update this file immediately after completing and testing each item. Commit after every 3-4 items.

---

## Phase 1: Pipeline Fixes + Cost Budgeting

### Model Upgrade
- [x] Update ALL Claude API calls to use `claude-sonnet-4-6` (was `claude-sonnet-4-5-20250514`). Update in lib/claude.ts, all prompt files, and Stagehand config.
- [x] **TEST**: Verify API calls work with the new model string.

### Journey Timing — Plan AFTER seeing the app
- [x] Add 'discovering' status to job status enum
- [x] Build discovery crawl: after login, visit each code analysis route quickly (5s max per page). For each route capture: URL, page title, isAccessible, hasError, hasForm, hasTable, navElements. No Claude calls. Store as DiscoveryResult[].
- [x] Update journey planner to accept DiscoveryResult[] — only plan journeys for accessible, error-free pages
- [x] Update orchestrator flow: code analysis → PRD analysis → login → discovery → plan journeys → execute → analyze → generate
- [x] **TEST**: Verify discovery correctly identifies broken pages. Verify journeys exclude error pages.

### Cost Budget System
- [x] Add `credits` column (integer, default 300 = $3.00 in cents) to profiles table in Supabase
- [x] Before journey planning: estimate total job cost based on discovered screen count
  - Formula: (screens × $0.03 per screen analysis) + (journeys × $0.08 per journey prose) + ($0.30 fixed for cross-cutting + overview) + ($0.30-0.90 for code analysis)
  - If estimated cost > user's remaining credits: reduce number of journeys to fit budget
  - Pick the highest-value journeys (creation journeys + main CRUD flows) that fit within budget
- [x] Cap: maximum 3-4 journeys for free tier, covering ~15-20 screens max. This keeps runs under $3.
- [x] For apps with 100+ pages: only document the first 3-4 core journeys. Show the user what other journeys COULD be documented (as a locked/upgrade list) but don't execute them.
- [x] After job completes: deduct actual API cost from user credits. Store actual_cost on job record.
- [x] Before starting a job: check if user has credits > 0. If not, return error "No credits remaining."
- [x] Broadcast budget info: "Estimated cost: $X.XX for Y journeys (Z screens). Credits remaining: $X.XX"
- [x] **TEST**: Verify cost estimation is within 20% of actual cost. Verify credit deduction works.

### Analysis Visibility — Show the Value
- [x] After code analysis: broadcast detailed summary to progress feed AND store on job record:
  - "Code Analysis Complete:"
  - "  Framework: Next.js App Router"
  - "  Routes found: 12"
  - "  Components analyzed: 8"
  - "  Form fields extracted: 24 across 5 forms"
  - "  Permissions detected: 3 role-based checks"
  - "  API endpoints: 6"
  - Show each route path found
- [x] After PRD analysis: broadcast detailed summary:
  - "PRD Analysis Complete:"
  - "  Product: [name]"
  - "  Target users: [list]"
  - "  Features identified: [count] — [list names]"
  - "  Workflows mapped: [count] — [list names]"
  - "  User roles: [list]"
  - "  Terminology: [count] terms"
  - If no PRD provided: "No PRD provided — documentation will be based on code analysis and visual observation only."
- [x] After discovery: broadcast what the agent actually saw:
  - "Discovery Complete — [X] accessible pages, [Y] had errors (skipped)"
  - For each accessible page: one-line summary
- [x] After journey planning: broadcast ALL planned journeys with reasoning:
  - "Documentation Plan — [X] journeys within $Y.YY budget:"
  - For each: "  [priority]. [title] ([step count] steps) — [one-line description]"
  - If journeys were cut for budget: "  Note: [Z] additional journeys available with more credits"
  - Store in jobs.journeys field
- [x] **TEST**: Run pipeline. Verify all summaries appear in progress feed. Verify code analysis shows real extracted data. Verify PRD shows extracted features.

### Journey Execution — Stop Skipping
- [x] Journey start: broadcast "Starting journey: [title] ([X] steps)"
- [x] Each step: broadcast "Journey [title] — Step X/Y: [action description]"
- [x] Step failure: broadcast "Step X failed: [error]. Continuing to next step."
- [x] Journey end: broadcast "Journey [title] complete: X/Y steps succeeded"
- [x] Never silently skip. Always explain what happened.
- [x] **TEST**: Run pipeline. Verify every journey has step-by-step logging. Zero silent skips.

---

## Phase 2: Markdown Documentation Output

### Replace .docx with Markdown
- [x] Create `engines/markdown-generator.ts` (keep old doc-generator.ts as reference)
- [x] Output folder structure: docs/ with index.md, quick-start.md, navigation.md, one .md per journey, glossary.md, images/ directory
- [x] Each .md uses relative image refs: `![Description](./images/filename.png)`
- [x] Upload all files to Supabase Storage under `jobs/{job_id}/docs/`
- [x] Generate .zip of entire docs/ folder, upload to Supabase Storage

### Linear Docs style — concise, image-first
- [x] Rewrite `prompts/journey-prose.ts` to produce markdown:
  - Title (action-oriented)
  - 2-3 sentence intro MAX
  - Hero screenshot (markdown image syntax)
  - "How to get there" — navigation from sidebar/home
  - Numbered steps — ONE action per line, **bold** UI elements
  - Optional tip as blockquote
  - Field table only if page has form fields
  - Related links
  - BANNED: "This page displays", "You'll see", "Here you can", "This is designed to"
- [x] Rewrite `prompts/cross-cutting.ts` for markdown:
  - quick-start.md: 5 short steps
  - navigation.md: brief app layout description
  - glossary.md: only if terms genuinely need defining
- [x] Include code analysis insights in documentation where valuable:
  - Field validation rules (from code) appear in field tables
  - Permission requirements (from code) noted in steps
  - API details NOT included (end-user docs, not developer docs)
- [x] Include PRD context where valuable:
  - Product overview uses PRD description
  - Journey intros reference business purpose from PRD
  - Glossary includes PRD terminology
- [x] Generate index.md with table of contents linking all sections
- [x] **TEST**: Generate markdown for test app. Print index.md + one journey file. Verify Linear docs style. Verify code analysis data enriches field descriptions. Verify PRD enriches overview.

### Browser docs viewer
- [x] Install react-markdown, remark-gfm, @tailwindcss/typography in apps/web
- [x] Create `/jobs/[id]/docs/page.tsx`
- [x] Left sidebar: clickable section list from index.md links
- [x] Main content: rendered markdown with react-markdown + remark-gfm
- [x] Tailwind Typography prose styling — clean, readable, like Linear docs
- [x] Images inline from Supabase Storage URLs
- [x] Header: app name + "Download .zip" button
- [x] Update job result: docs_url + zip_url (remove old doc_url)
- [x] **TEST**: Verify docs render with sidebar nav. Images display. Download works. Take screenshot.

---

## Phase 3: Frontend UI Overhaul

### Auth simplification
- [ ] Single /login page: email + password, toggle "Sign in" / "Create account"
- [ ] On signup: auto-create profile with 300 credits ($3.00)
- [ ] After auth: redirect to /new
- [ ] Remove /dashboard (redirect to /new)

### Generate page (/new)
- [ ] Required fields: App URL, Login URL, Username, Password
- [ ] Optional collapsed section: GitHub URL, PRD upload, Product Description
- [ ] Localhost detection: yellow callout with ngrok instructions
- [ ] Show remaining credits: "$X.XX remaining"
- [ ] If completed job exists: banner "Your last docs are ready → View"

### Progress page (/jobs/[id]) overhaul
- [ ] Top: large current status text + pulsing animation
- [ ] Show code analysis summary when complete (what was extracted)
- [ ] Show PRD summary when complete (what was understood)
- [ ] Show discovery summary (accessible pages found)
- [ ] Show journey plan card: all planned journeys with step counts. Note if any journeys were cut for budget. Checkmarks on completion.
- [ ] Show budget: "Estimated: $X.XX / Credits: $X.XX remaining"
- [ ] Activity feed: larger screenshots, grouped by journey, color-coded
- [ ] Completion: "Documentation Ready!" + "View Documentation →" button + "Download .zip" + stats + actual cost

### Landing page (/)
- [ ] Hero: "End-user documentation for your SaaS, generated in minutes"
- [ ] Subtext + one CTA: "Get Started Free →"
- [ ] "How it works" — 3 steps
- [ ] Nothing else. Minimal.
- [ ] **TEST**: Full flow walkthrough with screenshots of every page.

---

## Phase 4: Test + Deploy

- [ ] Full pipeline test against SaaS Starter
- [ ] Verify credit system works (starts at $3, deducts after job)
- [ ] Verify markdown output quality
- [ ] Verify docs viewer renders correctly
- [ ] Fix issues
- [ ] Commit, push, Railway + Vercel auto-deploy
- [ ] Test deployed version end-to-end
- [ ] **MILESTONE**: V2 in production