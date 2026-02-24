---
description: Rules for markdown documentation generation
globs: ["apps/worker/src/engines/markdown-generator.ts", "apps/worker/src/doc-components/**", "apps/worker/src/prompts/**"]
---

# Markdown Documentation Rules

- Output is .md files with relative image references: ![desc](./images/filename.png)
- Use Claude model `claude-sonnet-4-6` for ALL API calls
- Linear docs style: clean, concise, image-first
- Journey pages: title, 2-3 sentence intro, hero screenshot, "How to get there", numbered steps, field table, related links
- Steps: ONE action per numbered line. Bold UI elements: **Button Name**
- NEVER: "This page displays", "You'll see", "Here you can", "This is designed to", "As shown above"
- Screenshots are supplements — don't describe them in text
- Code analysis enriches field tables: include validation rules, types, permissions from code_context
- PRD analysis enriches intros and glossary: use business context, terminology, role descriptions
- If a section would be empty or forced, omit it
- index.md links to every other .md file with relative paths
- Generate .zip of docs/ folder for download
- Keep total API cost under user's credit budget — track tokens used