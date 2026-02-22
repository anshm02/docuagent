# DocuAgent Build Plan

Check off each task as completed. Claude: update this file after completing each item.

---

## Phase 1: Setup + Analysis Engines

- [x] Initialize Turborepo monorepo: `apps/web`, `apps/worker`, `packages/shared`
- [x] Configure root `tsconfig.base.json` and per-app tsconfig files
- [x] Set up `packages/shared/types.ts` with all TypeScript interfaces
- [x] Create Supabase migration (`supabase/migrations/001_initial_schema.sql`) with all tables + RLS
- [x] Set up `apps/worker/src/lib/supabase.ts` — Supabase client with service role key
- [x] Set up `apps/worker/src/lib/claude.ts` — Anthropic SDK wrapper (text + vision calls)
- [x] Set up `apps/worker/src/lib/github.ts` — GitHub API client (fetch tree, fetch file)
- [x] Build `engines/code-analysis.ts` + `prompts/code-analysis.ts`:
  - [x] Fetch repo tree via GitHub API
  - [x] Framework detection (parse package.json)
  - [x] Next.js App Router route extraction (find page.tsx files)
  - [x] React Router route extraction (send config to Claude)
  - [x] Component analysis (send source to Claude, parse JSON)
  - [x] Compile CrawlPlan JSON
  - [x] Fallback: return empty plan if no repo or <5 routes
- [x] Build `engines/prd-analysis.ts` + `prompts/prd-summary.ts`:
  - [ ] File parsers: mammoth (docx), pdf-parse (pdf), raw (txt/md)
  - [x] Single Claude call → PRDSummary JSON
- [x] Build `engines/journey-planner.ts` + `prompts/journey-planning.ts`:
  - [x] Send CrawlPlan + PRDSummary to Claude
  - [x] Parse Journey[] response, sort by priority (creation first)
- [x] **TEST**: Run all three engines against a real GitHub repo + sample PRD. Verify crawl plan, PRD summary, and journey plan output.

---

## Phase 2: Crawl Engine

- [ ] Set up `apps/worker/src/lib/stagehand.ts` — Stagehand v3 init + helpers
- [ ] Build `engines/crawl.ts`:
  - [ ] Authentication flow (observe form, fill creds, submit, verify)
  - [ ] Journey execution loop (navigate, wait, screenshot 1280x800, extract DOM, upload to Supabase)
  - [ ] Dynamic route parameter resolution (visit list views, extract entity IDs from links)
  - [ ] Form filling during creation journeys (generate test data from code context, submit, capture entity ID)
  - [ ] Modal interaction (click trigger, wait, screenshot, close)
  - [ ] Tab interaction (click each tab, screenshot)
  - [ ] Dropdown expansion (click, screenshot options)
  - [ ] Stagehand nav discovery fallback (observe sidebar/nav when no code routes)
  - [ ] Session expiry detection (redirect to login → re-auth)
  - [ ] Error handling: 30s timeout per page, skip failures, continue
  - [ ] Duplicate detection (DOM hash, skip >95% similarity)
  - [ ] Progress broadcasting to Supabase Realtime
  - [ ] 50 screen cap per job
- [ ] **TEST**: Agent logs into a real staging app, walks through journeys, captures screenshots. Debug auth, navigation, interaction failures.

---

## Phase 3: Screen Analysis + Document Generation

- [ ] Build `engines/screen-analysis.ts` + `prompts/screen-analysis.ts`:
  - [ ] Context assembly per screen (screenshot base64 + DOM + code_context + prd_summary + journey_context)
  - [ ] Claude Vision call with multi-source prompt
  - [ ] JSON response parsing + validation
  - [ ] Parallel execution: batch 5 concurrent calls
  - [ ] Store analysis in Supabase, compute confidence scores
- [ ] Build `doc-components/design-tokens.ts` — colors, fonts, spacing
- [ ] Build `doc-components/components.ts`:
  - [ ] Headings (h1, h2, h3), paragraph, bullet list, numbered steps
  - [ ] Screenshot embed (ImageRun, page width, max height)
  - [ ] Field reference table, permission table
  - [ ] Callout box (tip/warning), navigation path breadcrumb
- [ ] Build `doc-components/templates.ts`:
  - [ ] Cover page, TOC, journey section, screen reference, glossary, confidence appendix
- [ ] Build `engines/doc-generator.ts` + prompts (`journey-prose.ts`, `cross-cutting.ts`):
  - [ ] AI: journey guide prose per journey
  - [ ] AI: cross-cutting (Quick Start, Navigation, Glossary, FAQ)
  - [ ] AI: product overview
  - [ ] Assembly: cover → TOC → overview → Quick Start → Navigation → Journey guides → Screen appendix → Glossary → FAQ → Confidence appendix
  - [ ] Screenshot embedding (fetch, resize with sharp, embed)
  - [ ] Upload .docx to Supabase Storage
  - [ ] Quality score + auto-flagging
- [ ] **TEST**: Generate complete .docx from captured data. Verify it opens and reads well.

---

## Phase 4: Orchestrator + API + Deploy

- [ ] Build `orchestrator.ts` — coordinate all 6 stages, update status, handle partial failure, delete creds, set result
- [ ] Build `index.ts` — Express server: POST /api/jobs, GET /api/jobs/:id, GET /health
- [ ] Build `test-run.ts` — full end-to-end test script
- [ ] **TEST**: test-run.ts → submit job → full pipeline → download .docx
- [ ] Test against 3+ different apps, fix everything
- [ ] Write Dockerfile, deploy to Railway, set env vars
- [ ] **TEST**: curl deployed API, verify end-to-end

---

## Phase 5: Frontend + Beta

- [ ] Next.js + Tailwind + Supabase Auth setup
- [ ] Login/signup, job creation (/new), job status (/jobs/[id]), dashboard
- [ ] Wire to Railway API, deploy to Vercel
- [ ] Landing page, test full flow
- [ ] Onboard beta users, $3 free credit, collect feedback
