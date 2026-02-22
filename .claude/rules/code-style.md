---
description: Code style rules for the DocuAgent project
globs: ["**/*.ts", "**/*.tsx"]
---

# Code Style

- TypeScript strict mode. No `any` types except when interfacing with external untyped libraries.
- ES modules only: `import/export`, never `require()`.
- Destructure imports: `import { createClient } from "@supabase/supabase-js"`.
- Use `const` by default. `let` only when reassignment is needed. Never `var`.
- Async/await over .then() chains.
- Error handling: wrap external API calls (Claude, GitHub, Supabase) in try/catch. Log errors with context. Don't swallow errors silently.
- File naming: kebab-case for files (`code-analysis.ts`), PascalCase for React components (`JobCard.tsx`).
- Export named exports, not default exports (except Next.js pages which require default).
- Keep functions under 50 lines. Extract helpers when functions grow.
- Comments: only when the "why" isn't obvious. Don't comment the "what".