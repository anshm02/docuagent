# DocuAgent — Autonomous SaaS Documentation Generator

## Project Overview
DocuAgent is a web app that autonomously crawls SaaS applications and generates end-user documentation (.docx). It combines browser automation (Stagehand v3), codebase analysis (GitHub API + Claude), and AI vision analysis (Claude Sonnet 4.5) to produce professional documentation with screenshots, field descriptions, and workflow guides.

## CRITICAL RULES — READ FIRST

### Rule 1: Always Test Your Own Work
You MUST test everything you build before presenting it to me. Never say "this should work" or "you can test this by..." — YOU run it, YOU verify the output, YOU fix errors. Specifically:
- After writing any engine/module: create a test script and RUN it. Show me the actual output.
- After building an API endpoint: curl it yourself and show me the response.
- After generating a .docx: verify the file was created, check the file size is reasonable (>10KB for a real doc), and confirm it's valid.
- After any database operation: query the database and show me the inserted/updated rows.
- If a test fails: fix the error and re-run until it passes. Do NOT return to me with a failing test.
- Run tests as background tasks when useful so you can see logs in real-time.

### Rule 2: When I Need to Do Something, Give Me Exact Instructions
If you need me to set up an external service, create an account, get an API key, or do anything outside the codebase, give me:
- Step-by-step numbered instructions (what to click, what to copy)
- The exact URL to go to
- What the expected output looks like
- Where to paste/save the result (exact file path or env var name)
- A verification command I can run to confirm it worked

Example of GOOD setup instructions:
```
I need you to set up Supabase. Here's exactly what to do:

1. Go to https://supabase.com/dashboard and sign in (or create account)
2. Click "New Project" → name it "docuagent" → set a database password → select region closest to you → click "Create"
3. Wait ~2 minutes for provisioning
4. Go to Settings → API. Copy these three values:
   - Project URL (looks like https://xxxxx.supabase.co)
   - anon/public key (starts with eyJ...)
   - service_role key (starts with eyJ... — this is the secret one)
5. Create a file at the project root called .env and paste:
   NEXT_PUBLIC_SUPABASE_URL=<your project URL>
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<your anon key>
   SUPABASE_SERVICE_ROLE_KEY=<your service role key>
6. After you've done this, tell me and I'll run the migration and verify the connection.
```

Example of BAD setup instructions:
```
You'll need to set up Supabase and add the credentials to your environment.
```

### Rule 3: Check Off PLAN.md After Each Completed + Tested Task
After completing AND testing each item in PLAN.md, update the checkbox from `- [ ]` to `- [x]`. This is how we track progress across sessions.

### Rule 4: Handle Errors Proactively
- If an npm install fails: read the error, fix it, retry.
- If a TypeScript compilation fails: fix the type error, don't skip it.
- If a Claude API call returns an error: check the API key, check the model name, check the request format.
- If Supabase rejects a query: check RLS policies, check the service role key, check table names.
- If Stagehand crashes: check Chromium is installed, check the environment setup.
- Never leave broken code. If something doesn't work, fix it before moving on.

### Rule 5: Show Me Proof
When you complete a phase, show me:
- The test command you ran
- The actual output (not a summary — the real terminal output)
- Any files created (with file sizes)
- Confirmation that PLAN.md is updated

---

## Tech Stack
- **Monorepo**: Turborepo with two apps (web + worker)
- **Frontend**: Next.js 14 App Router, TypeScript, Tailwind CSS
- **Backend/Worker**: Node.js + Stagehand v3 — single process on Railway
- **Database**: Supabase (PostgreSQL + Auth + Storage + Realtime)
- **AI**: Anthropic Claude API (Sonnet 4.5 — vision + text)
- **Code Analysis**: GitHub REST API
- **Doc Generation**: `docx` npm package
- **Queue**: None for MVP — sequential processing in same process

## Architecture
Single Railway instance handles API endpoints AND job processing. No Redis queue. Jobs process sequentially. Supabase is the only external data service.

```
User → Next.js (Vercel) → Railway (API + Worker) → Supabase
                                                  → Claude API
                                                  → GitHub API
```

## Key Conventions
- TypeScript everywhere. No Python. ES modules (import/export), never require().
- `@/` path alias for imports within each app.
- Destructure imports.
- All AI prompts in `apps/worker/src/prompts/` as exported template literal functions.
- All docx components in `apps/worker/src/doc-components/` as pure functions.
- Shared types in `packages/shared/types.ts`.
- Never hardcode API keys. Use `process.env.X`.

## Important Files
- `@SPEC.md` — Full technical spec with interfaces, prompts, schema, project structure
- `@PLAN.md` — Build checklist (check off as you go)
- `apps/worker/src/orchestrator.ts` — Main pipeline coordinator
- `apps/worker/src/engines/` — One file per pipeline stage
- `apps/worker/src/prompts/` — All Claude prompt templates
- `apps/worker/src/doc-components/` — Docx rendering components

## Pipeline Stages (in order)
1. **Code Analysis** (`engines/code-analysis.ts`): GitHub repo → detect framework → extract routes → analyze components → CrawlPlan. Falls back to Stagehand nav discovery if <5 routes.
2. **PRD Analysis** (`engines/prd-analysis.ts`): Parse PRD → single Claude call → PRDSummary JSON.
3. **Journey Planning** (`engines/journey-planner.ts`): CrawlPlan + PRDSummary → Claude → 5-7 user journeys. Creation journeys first.
4. **Crawl Execution** (`engines/crawl.ts`): Stagehand v3 authenticates → walks journeys → viewport screenshots (1280x800) → interacts with modals/tabs/dropdowns → creates sample data → stores in Supabase.
5. **Screen Analysis** (`engines/screen-analysis.ts`): Per screen: screenshot + DOM + code + PRD + journey context → Claude Vision → ScreenAnalysis JSON. Batch 5 concurrent.
6. **Document Generation** (`engines/doc-generator.ts`): AI generates journey prose + cross-cutting content → programmatic .docx assembly. Workflow-first structure.

## Document Structure (Workflow-First)
1. Cover page → 2. TOC → 3. Product overview → 4. Quick Start → 5. Navigation guide → 6. **Journey guides (PRIMARY)** → 7. Screen Reference appendix → 8. Glossary → 9. FAQ → 10. Confidence appendix

## Error Handling
- Login fails: retry once, then fail job with clear error.
- Page timeout (30s): skip, log, continue.
- Modal/tab/dropdown interaction fails: log, skip, continue.
- Crawl fails partway: generate doc with whatever was captured (if ≥3 screens).
- Code analysis fails: silent fallback to Stagehand nav discovery.

## Quality Scoring
(screens with confidence ≥ 4) / total_screens × 100. If <60%, set flagged_for_review = true.

## When Compacting Context
Always preserve: full list of modified files, current PLAN.md position, test commands, current pipeline stage being built.