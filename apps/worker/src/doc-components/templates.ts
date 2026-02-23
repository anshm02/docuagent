// ============================================================
// DocuAgent — Document Templates
// Higher-level template functions for document sections
// ============================================================

import {
  Paragraph,
  TextRun,
  AlignmentType,
  TableOfContents,
  Table,
} from "docx";
import { colors, fonts, fontSizes, spacing } from "./design-tokens.js";
import {
  h1, h2, h3, paragraph, boldParagraph, caption,
  bulletItem, numberedStep,
  screenshotEmbed, fieldTable, permissionTable, confidenceTable,
  tipCallout, warningCallout, navigationBreadcrumb,
  pageBreak, spacer,
} from "./components.js";
import type { ScreenAnalysis, JourneyProse, CrossCuttingContent } from "@docuagent/shared";

// ---------------------------------------------------------------------------
// Cover page
// ---------------------------------------------------------------------------

export function coverPage(appName: string, generatedDate: string): Paragraph[] {
  return [
    spacer(3000),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: appName,
          bold: true,
          size: fontSizes.coverTitle,
          color: colors.primary,
          font: fonts.heading,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: "User Documentation",
          size: fontSizes.coverSubtitle,
          color: colors.secondary,
          font: fonts.heading,
        }),
      ],
    }),
    spacer(1000),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: `Generated on ${generatedDate}`,
          size: fontSizes.body,
          color: colors.muted,
          font: fonts.body,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "Powered by DocuAgent",
          size: fontSizes.small,
          color: colors.muted,
          font: fonts.body,
          italics: true,
        }),
      ],
    }),
  ];
}

// ---------------------------------------------------------------------------
// Table of Contents
// ---------------------------------------------------------------------------

export function tableOfContents(): Paragraph[] {
  return [
    pageBreak(),
    h1("Table of Contents"),
    new Paragraph({
      children: [
        new TextRun({
          text: "This document contains the following sections. Use your document viewer's navigation to jump to any section.",
          size: fontSizes.body,
          color: colors.muted,
          font: fonts.body,
          italics: true,
        }),
      ],
    }),
    spacer(200),
  ];
}

// ---------------------------------------------------------------------------
// Product Overview section
// ---------------------------------------------------------------------------

export function productOverviewSection(overview: string): Paragraph[] {
  return [
    pageBreak(),
    h1("Product Overview"),
    paragraph(overview),
  ];
}

// ---------------------------------------------------------------------------
// Quick Start section
// ---------------------------------------------------------------------------

export function quickStartSection(steps: string[]): Paragraph[] {
  const elements: Paragraph[] = [
    pageBreak(),
    h1("Quick Start Guide"),
    paragraph("Get up and running quickly by following these steps:"),
    spacer(100),
  ];

  steps.forEach((step, idx) => {
    elements.push(numberedStep(idx + 1, step));
  });

  return elements;
}

// ---------------------------------------------------------------------------
// Navigation Guide section
// ---------------------------------------------------------------------------

export function navigationGuideSection(guide: string): Paragraph[] {
  // Split the guide into paragraphs
  const paragraphs = guide.split("\n\n").filter((p) => p.trim());

  return [
    pageBreak(),
    h1("Navigation Guide"),
    ...paragraphs.map((p) => paragraph(p.trim())),
  ];
}

// ---------------------------------------------------------------------------
// Journey Guide section
// ---------------------------------------------------------------------------

export function journeySection(
  journeyTitle: string,
  prose: JourneyProse,
  screenshots: Map<string, { buffer: Buffer; width: number; height: number }>,
): (Paragraph | Table)[] {
  const elements: (Paragraph | Table)[] = [
    pageBreak(),
    h2(journeyTitle),
    paragraph(prose.overview),
    spacer(100),
  ];

  // Steps
  for (const step of prose.steps) {
    elements.push(h3(step.heading));
    elements.push(paragraph(step.body));

    // Embed screenshot if available
    const screenshot = screenshots.get(step.screenshot_ref);
    if (screenshot) {
      const imgs = screenshotEmbed(
        screenshot.buffer,
        screenshot.width,
        screenshot.height,
        step.heading,
      );
      elements.push(...imgs);
    }
  }

  // Tips
  if (prose.tips.length > 0) {
    elements.push(h3("Tips"));
    for (const tip of prose.tips) {
      elements.push(tipCallout(tip));
    }
  }

  // Troubleshooting
  if (prose.troubleshooting.length > 0) {
    elements.push(h3("Troubleshooting"));
    for (const item of prose.troubleshooting) {
      elements.push(bulletItem(item));
    }
  }

  return elements;
}

// ---------------------------------------------------------------------------
// Screen Reference appendix
// ---------------------------------------------------------------------------

export function screenReferenceSection(
  screens: {
    analysis: ScreenAnalysis;
    screenshot?: { buffer: Buffer; width: number; height: number };
  }[],
): (Paragraph | Table)[] {
  const elements: (Paragraph | Table)[] = [
    pageBreak(),
    h1("Screen Reference"),
    paragraph("This appendix provides a detailed reference for every screen in the application."),
    spacer(100),
  ];

  // Sort by page title alphabetically
  const sorted = [...screens].sort((a, b) =>
    a.analysis.page_title.localeCompare(b.analysis.page_title),
  );

  for (const screen of sorted) {
    const { analysis } = screen;

    elements.push(h2(analysis.page_title));
    elements.push(navigationBreadcrumb(analysis.navigation_path));
    elements.push(paragraph(analysis.overview_paragraph));

    // Screenshot
    if (screen.screenshot) {
      elements.push(
        ...screenshotEmbed(
          screen.screenshot.buffer,
          screen.screenshot.width,
          screen.screenshot.height,
        ),
      );
    }

    // Fields table
    if (analysis.fields.length > 0) {
      elements.push(h3("Fields"));
      elements.push(fieldTable(analysis.fields));
    }

    // Actions
    if (analysis.actions.length > 0) {
      elements.push(h3("Available Actions"));
      for (const action of analysis.actions) {
        elements.push(bulletItem(`${action.label}: ${action.description}`));
      }
    }

    // Permissions
    if (analysis.permissions.length > 0) {
      elements.push(h3("Permissions"));
      elements.push(permissionTable(analysis.permissions));
    }

    // Tips
    if (analysis.tips.length > 0) {
      elements.push(h3("Tips"));
      for (const tip of analysis.tips) {
        elements.push(tipCallout(tip));
      }
    }
  }

  return elements;
}

// ---------------------------------------------------------------------------
// Glossary section
// ---------------------------------------------------------------------------

export function glossarySection(
  glossary: { term: string; definition: string }[],
): (Paragraph | Table)[] {
  const elements: (Paragraph | Table)[] = [
    pageBreak(),
    h1("Glossary"),
  ];

  const sorted = [...glossary].sort((a, b) => a.term.localeCompare(b.term));

  for (const entry of sorted) {
    elements.push(boldParagraph(entry.term));
    elements.push(paragraph(entry.definition));
  }

  return elements;
}

// ---------------------------------------------------------------------------
// FAQ section
// ---------------------------------------------------------------------------

export function faqSection(
  faq: { question: string; answer: string }[],
): Paragraph[] {
  const elements: Paragraph[] = [
    pageBreak(),
    h1("Frequently Asked Questions"),
  ];

  for (const item of faq) {
    elements.push(boldParagraph(`Q: ${item.question}`));
    elements.push(paragraph(`A: ${item.answer}`));
    elements.push(spacer(80));
  }

  return elements;
}

// ---------------------------------------------------------------------------
// Confidence appendix
// ---------------------------------------------------------------------------

export function confidenceAppendix(
  screens: { title: string; confidence: number; notes: string }[],
  qualityScore: number,
): (Paragraph | Table)[] {
  return [
    pageBreak(),
    h1("Documentation Confidence Report"),
    paragraph(
      `This appendix shows the confidence level for each screen's documentation. ` +
      `The overall quality score is ${qualityScore}%. ` +
      `Screens with confidence 4-5 have high-quality documentation backed by multiple data sources. ` +
      `Screens with confidence 1-3 may need manual review.`,
    ),
    spacer(100),
    confidenceTable(screens),
  ];
}
