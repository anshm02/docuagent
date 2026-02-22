---
description: Rules for writing Claude API prompt templates
globs: ["apps/worker/src/prompts/**"]
---

# Prompt Template Rules

- Every prompt template is a function that accepts parameters and returns a string.
- Always request JSON output from Claude. Specify the exact JSON schema in the prompt.
- Include "Return ONLY valid JSON. No markdown, no explanation, no backticks." at the end of every prompt.
- Keep prompts focused: one task per call. Don't combine analysis + generation.
- Include context boundaries: clearly label each section (SCREENSHOT, DOM, CODE ANALYSIS, PRD CONTEXT).
- For vision calls, always include both the image AND text context (DOM + code). Vision alone is not enough.
- Set temperature to 0 for analysis calls (we want deterministic output).
- Set max_tokens appropriately: ~2000 for screen analysis, ~4000 for journey prose, ~3000 for cross-cutting content.