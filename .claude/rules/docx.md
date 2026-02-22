---
description: Rules for docx document generation
globs: ["apps/worker/src/doc-components/**", "apps/worker/src/engines/doc-generator.ts"]
---

# Docx Generation Rules

- Use the `docx` npm package (version 9.x). Import from 'docx'.
- Set page size explicitly to US Letter: width: 12240, height: 15840 (DXA units).
- Set 1-inch margins: 1440 DXA on all sides.
- Never use `\n` in text — use separate Paragraph elements.
- Never use unicode bullets — use LevelFormat.BULLET with numbering config.
- Tables: always set both `columnWidths` on table AND `width` on each cell. Use WidthType.DXA, never PERCENTAGE.
- Use ShadingType.CLEAR for table cell backgrounds, never SOLID.
- Screenshots: embed as ImageRun with type specified. Scale to content width (9360 DXA = ~6.5 inches) with proportional height, max 5 inches tall.
- Heading styles: override built-in IDs ("Heading1", "Heading2", "Heading3") with outlineLevel for TOC.
- Document structure is WORKFLOW-FIRST: journey guides are primary content, screen reference is appendix.
- Every component function should return Paragraph | Table | Paragraph[] — pure functions, no side effects.