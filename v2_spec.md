# DocuAgent V2 — Specification Addendum

Supplements existing SPEC.md. When conflicts exist, this document takes priority.

---

## Model Upgrade

ALL Claude API calls use `claude-sonnet-4-6` (was `claude-sonnet-4-5-20250514`).
Same pricing: $3/M input, $15/M output. Better at coding, vision, and agentic tasks.

Update in: lib/claude.ts, Stagehand config, and any hardcoded model strings.

---

## Pipeline: New Stage Order

```
code analysis → PRD analysis → login + discovery crawl → cost estimation + journey planning → journey execution → screen analysis → markdown generation
```

### New Stage: Discovery Crawl

Runs AFTER login, BEFORE journey planning. Zero AI cost — just Stagehand navigation.

```typescript
interface DiscoveryResult {
  route: string;
  actualUrl: string;
  pageTitle: string;
  isAccessible: boolean;
  hasForm: boolean;
  hasTable: boolean;
  hasError: boolean;
  navElements: string[];
  screenshotUrl: string;
}
```

Process: visit each code analysis route (5s max), note what's there, move on.

### Cost Budget System

```typescript
interface CostEstimate {
  screens_estimated: number;
  journeys_planned: number;
  journeys_available: number;    // total possible (may be more than planned)
  estimated_cost_cents: number;  // in cents
  user_credits_cents: number;    // user's remaining credits
  journeys_cut_for_budget: number; // how many journeys were dropped to fit budget
}
```

**Cost formula per job:**
- Code analysis: ~$0.30-0.90 (component analysis calls)
- PRD analysis: ~$0.05 (one call)
- Discovery crawl: ~$0.00 (no AI calls)
- Journey planning: ~$0.05 (one call)
- Screen analysis: ~$0.03 per screen (vision call)
- Journey prose: ~$0.08 per journey (text call)
- Cross-cutting content: ~$0.25 (2-3 calls)
- Total per journey (avg 4 screens): ~$0.20
- Fixed overhead: ~$0.65

**Budget logic:**
```
available_budget = user_credits - fixed_overhead ($0.65)
cost_per_journey = 0.20  // ~4 screens × $0.03 + $0.08 prose
max_journeys = floor(available_budget / cost_per_journey)
max_journeys = min(max_journeys, total_available_journeys)
max_journeys = max(max_journeys, 1)  // always do at least 1
max_journeys = min(max_journeys, 5)  // cap at 5 for free tier even with budget
```

For $3.00 budget: ($3.00 - $0.65) / $0.20 = ~11 journeys max. Cap at 5 for free tier.
Actual cost will be $1.50-2.50 for 3-5 journeys. Well within $3.

**For 100+ page apps:** Journey planner identifies ALL possible journeys, but only executes the top 3-5 based on priority. Show user: "We identified 12 possible journeys. Documenting the top 4 within your free credits. Upgrade to document all 12."

### Profiles Table Update
```sql
ALTER TABLE profiles ADD COLUMN credits INTEGER DEFAULT 300; -- $3.00 in cents
```

### Jobs Table Update
```sql
ALTER TABLE jobs ADD COLUMN estimated_cost_cents INTEGER;
ALTER TABLE jobs ADD COLUMN actual_cost_cents INTEGER;
ALTER TABLE jobs ADD COLUMN discovery_data JSONB;
```

---

## Analysis Visibility

### Code Analysis Output — Show in Progress Feed

After code analysis, broadcast a structured summary:
```
Code Analysis Complete:
  Framework: Next.js App Router
  Routes found: 12
  Components analyzed: 8
  Form fields extracted: 24 across 5 forms
  Permissions detected: 3 role-based checks
  Routes: /dashboard, /settings, /team, /projects, /projects/[id], ...
```

Store this summary in the job record so the frontend can display it as a card.

**Why this matters:** Users see that code analysis actually extracted real data from their codebase. If they didn't provide a GitHub URL, they see what they're missing: "No code analysis — provide a GitHub URL to improve documentation with field types, validation rules, and permissions."

### PRD Analysis Output — Show in Progress Feed

After PRD analysis, broadcast:
```
PRD Analysis Complete:
  Product: SaaS Starter
  Target users: small business owners, startup founders
  Features: Team Management, Dashboard, Billing, Activity Logging, Security Settings
  Workflows: User registration, Team setup, Subscription management
  Roles: Owner (full admin), Member (standard access)
  Terminology: 8 terms defined
```

If no PRD: "No PRD provided. Provide a product description or PRD to improve documentation with business context, workflow descriptions, and terminology."

**How analysis enriches documentation:**
- Code analysis → field validation rules in tables, permission notes in steps, accurate field types
- PRD analysis → product overview paragraph, business-context workflow descriptions, glossary terms, user role explanations
- Both together → the agent knows WHAT each field does (code) and WHY it exists (PRD)

---

## Journey Planning Prompt (Updated)

```
You are planning user journeys for documenting a SaaS application.

BUDGET CONSTRAINT: You may plan at most ${maxJourneys} journeys.

APP ROUTES (from code analysis — shows what pages exist and what they contain):
${JSON.stringify(crawlPlan.routes)}

DISCOVERY RESULTS (what the agent actually saw visiting each page):
${JSON.stringify(discoveryResults)}

PRODUCT CONTEXT (from PRD — business purpose and workflows):
${JSON.stringify(prdSummary)}

Generate exactly ${maxJourneys} user journeys that best showcase the application's core functionality. Prioritize variety — pick journeys that cover DIFFERENT parts of the app.

RULES:
- ONLY include routes that were accessible (isAccessible: true, hasError: false)
- Creation journeys FIRST (they populate the app with data)
- Pick journeys that show DIFFERENT features (don't do 3 settings journeys)
- Each journey: 3-6 steps max
- Use code analysis field data to specify realistic test input values
- Use PRD workflows to name and describe journeys in business terms

Also list ALL other possible journeys you identified but didn't include (as "additional_journeys" array with just titles and descriptions). These will be shown to the user as "available with upgrade."

Return JSON: { planned: Journey[], additional: { title: string, description: string }[] }
```

---

## Markdown Output

Same as previous V2_SPEC. Key addition: code analysis and PRD data should enrich the markdown:

**In field tables:** include validation rules from code analysis
```markdown
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| Email | email | Yes | Team member's email. Must be valid format. |
| Role | radio | No | Member (default) or Owner. Only Owners can manage billing. |
```

**In step descriptions:** include permission info from code
```markdown
> **Note:** Only users with the **Owner** role can invite team members.
```

**In overview paragraphs:** use PRD product description and feature context
**In glossary:** use PRD terminology definitions

---

## Job Status Enum (Updated)

```
queued → analyzing_code → analyzing_prd → discovering → planning_journeys → crawling → analyzing_screens → generating_docs → completed → failed
```

## Job Result JSON (Updated)

```typescript
interface JobResult {
  docs_url: string;           // /jobs/[id]/docs
  zip_url: string;            // Supabase Storage .zip URL
  total_screens: number;
  avg_confidence: number;
  duration_seconds: number;
  journeys_completed: number;
  journeys_total: number;
  estimated_cost_cents: number;
  actual_cost_cents: number;
  additional_journeys: { title: string; description: string }[];
}
```