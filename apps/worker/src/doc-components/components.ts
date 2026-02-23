// ============================================================
// DocuAgent — Document Components
// Pure functions returning docx Paragraph/Table elements
// ============================================================

import {
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  ImageRun,
  BorderStyle,
  ShadingType,
  TabStopPosition,
  TabStopType,
} from "docx";
import { colors, fonts, fontSizes, spacing, lineSpacing } from "./design-tokens.js";

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

export function h1(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: spacing.beforeH1, after: spacing.afterH1 },
    children: [
      new TextRun({
        text,
        bold: true,
        size: fontSizes.h1,
        color: colors.heading1,
        font: fonts.heading,
      }),
    ],
  });
}

export function h2(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: spacing.beforeH2, after: spacing.afterH2 },
    children: [
      new TextRun({
        text,
        bold: true,
        size: fontSizes.h2,
        color: colors.heading2,
        font: fonts.heading,
      }),
    ],
  });
}

export function h3(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: spacing.beforeH3, after: spacing.afterH3 },
    children: [
      new TextRun({
        text,
        bold: true,
        size: fontSizes.h3,
        color: colors.heading3,
        font: fonts.heading,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

export function paragraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: spacing.afterParagraph, line: lineSpacing.body },
    children: [
      new TextRun({
        text,
        size: fontSizes.body,
        color: colors.body,
        font: fonts.body,
      }),
    ],
  });
}

export function boldParagraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: spacing.afterParagraph, line: lineSpacing.body },
    children: [
      new TextRun({
        text,
        bold: true,
        size: fontSizes.body,
        color: colors.secondary,
        font: fonts.body,
      }),
    ],
  });
}

export function caption(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({
        text,
        italics: true,
        size: fontSizes.small,
        color: colors.muted,
        font: fonts.body,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export function bulletItem(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 60, line: lineSpacing.body },
    indent: { left: 720 }, // 0.5 inches
    children: [
      new TextRun({
        text: `\u2022  ${text}`,
        size: fontSizes.body,
        color: colors.body,
        font: fonts.body,
      }),
    ],
  });
}

export function numberedStep(num: number, text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80, line: lineSpacing.body },
    indent: { left: 720 },
    children: [
      new TextRun({
        text: `${num}.  `,
        bold: true,
        size: fontSizes.body,
        color: colors.primary,
        font: fonts.body,
      }),
      new TextRun({
        text,
        size: fontSizes.body,
        color: colors.body,
        font: fonts.body,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Screenshot embed
// ---------------------------------------------------------------------------

export function screenshotEmbed(
  imageBuffer: Buffer,
  widthPx: number,
  heightPx: number,
  captionText?: string,
): Paragraph[] {
  // Scale to content width (9360 DXA = ~6.5 inches)
  // 1 inch = 914400 EMU, 1 DXA = 635 EMU
  const contentWidthEmu = spacing.contentWidth * 635;
  const maxHeightEmu = spacing.screenshotMaxHeight * 635;

  // Calculate scaled dimensions in EMU
  const aspectRatio = heightPx / widthPx;
  let scaledWidthEmu = contentWidthEmu;
  let scaledHeightEmu = Math.round(contentWidthEmu * aspectRatio);

  // Cap height at 5 inches
  if (scaledHeightEmu > maxHeightEmu) {
    scaledHeightEmu = maxHeightEmu;
    scaledWidthEmu = Math.round(maxHeightEmu / aspectRatio);
  }

  const elements: Paragraph[] = [
    new Paragraph({
      spacing: { before: 120, after: 60 },
      alignment: AlignmentType.CENTER,
      children: [
        new ImageRun({
          data: imageBuffer,
          transformation: {
            width: Math.round(scaledWidthEmu / 9525), // EMU to pixels for docx
            height: Math.round(scaledHeightEmu / 9525),
          },
          type: "png",
        }),
      ],
    }),
  ];

  if (captionText) {
    elements.push(caption(captionText));
  }

  return elements;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const tableBorder = {
  style: BorderStyle.SINGLE,
  size: 1,
  color: colors.tableBorder,
};

const tableBorders = {
  top: tableBorder,
  bottom: tableBorder,
  left: tableBorder,
  right: tableBorder,
};

export function fieldTable(
  fields: { label: string; type: string; required: boolean; description: string }[],
): Table {
  const colWidths = [2000, 1200, 1000, 5160]; // label, type, required, description

  const headerRow = new TableRow({
    tableHeader: true,
    children: ["Field", "Type", "Required", "Description"].map(
      (text, i) =>
        new TableCell({
          width: { size: colWidths[i], type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: colors.tableHeader },
          borders: tableBorders,
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text,
                  bold: true,
                  size: fontSizes.small,
                  color: colors.heading2,
                  font: fonts.heading,
                }),
              ],
            }),
          ],
        }),
    ),
  });

  const dataRows = fields.map(
    (field, idx) =>
      new TableRow({
        children: [
          field.label,
          field.type,
          field.required ? "Yes" : "No",
          field.description,
        ].map(
          (text, i) =>
            new TableCell({
              width: { size: colWidths[i], type: WidthType.DXA },
              shading: idx % 2 === 1 ? { type: ShadingType.CLEAR, fill: colors.tableAlt } : undefined,
              borders: tableBorders,
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text,
                      size: fontSizes.small,
                      color: colors.body,
                      font: fonts.body,
                    }),
                  ],
                }),
              ],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: spacing.contentWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [headerRow, ...dataRows],
  });
}

export function permissionTable(
  permissions: { action: string; role: string }[],
): Table {
  const colWidths = [5000, 4360];

  const headerRow = new TableRow({
    tableHeader: true,
    children: ["Action", "Required Role"].map(
      (text, i) =>
        new TableCell({
          width: { size: colWidths[i], type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: colors.tableHeader },
          borders: tableBorders,
          children: [
            new Paragraph({
              children: [
                new TextRun({ text, bold: true, size: fontSizes.small, color: colors.heading2, font: fonts.heading }),
              ],
            }),
          ],
        }),
    ),
  });

  const dataRows = permissions.map(
    (perm, idx) =>
      new TableRow({
        children: [perm.action, perm.role].map(
          (text, i) =>
            new TableCell({
              width: { size: colWidths[i], type: WidthType.DXA },
              shading: idx % 2 === 1 ? { type: ShadingType.CLEAR, fill: colors.tableAlt } : undefined,
              borders: tableBorders,
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text, size: fontSizes.small, color: colors.body, font: fonts.body }),
                  ],
                }),
              ],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: spacing.contentWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [headerRow, ...dataRows],
  });
}

export function confidenceTable(
  screens: { title: string; confidence: number; notes: string }[],
): Table {
  const colWidths = [4000, 1360, 4000];

  const headerRow = new TableRow({
    tableHeader: true,
    children: ["Screen", "Confidence", "Notes"].map(
      (text, i) =>
        new TableCell({
          width: { size: colWidths[i], type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: colors.tableHeader },
          borders: tableBorders,
          children: [
            new Paragraph({
              children: [
                new TextRun({ text, bold: true, size: fontSizes.small, color: colors.heading2, font: fonts.heading }),
              ],
            }),
          ],
        }),
    ),
  });

  const dataRows = screens.map(
    (s, idx) =>
      new TableRow({
        children: [s.title, `${s.confidence}/5`, s.notes].map(
          (text, i) =>
            new TableCell({
              width: { size: colWidths[i], type: WidthType.DXA },
              shading: idx % 2 === 1 ? { type: ShadingType.CLEAR, fill: colors.tableAlt } : undefined,
              borders: tableBorders,
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text, size: fontSizes.small, color: colors.body, font: fonts.body }),
                  ],
                }),
              ],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: spacing.contentWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [headerRow, ...dataRows],
  });
}

// ---------------------------------------------------------------------------
// Callout boxes
// ---------------------------------------------------------------------------

export function tipCallout(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    indent: { left: 360, right: 360 },
    shading: { type: ShadingType.CLEAR, fill: colors.tipBg },
    border: {
      left: { style: BorderStyle.SINGLE, size: 6, color: colors.tipBorder },
    },
    children: [
      new TextRun({
        text: "TIP: ",
        bold: true,
        size: fontSizes.body,
        color: colors.tipBorder,
        font: fonts.body,
      }),
      new TextRun({
        text,
        size: fontSizes.body,
        color: colors.body,
        font: fonts.body,
      }),
    ],
  });
}

export function warningCallout(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    indent: { left: 360, right: 360 },
    shading: { type: ShadingType.CLEAR, fill: colors.warningBg },
    border: {
      left: { style: BorderStyle.SINGLE, size: 6, color: colors.warningBorder },
    },
    children: [
      new TextRun({
        text: "WARNING: ",
        bold: true,
        size: fontSizes.body,
        color: colors.warningBorder,
        font: fonts.body,
      }),
      new TextRun({
        text,
        size: fontSizes.body,
        color: colors.body,
        font: fonts.body,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Navigation breadcrumb
// ---------------------------------------------------------------------------

export function navigationBreadcrumb(path: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({
        text: "Navigation: ",
        bold: true,
        size: fontSizes.small,
        color: colors.muted,
        font: fonts.body,
      }),
      new TextRun({
        text: path,
        size: fontSizes.small,
        color: colors.primary,
        font: fonts.body,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Page break
// ---------------------------------------------------------------------------

export function pageBreak(): Paragraph {
  return new Paragraph({
    pageBreakBefore: true,
    children: [],
  });
}

// ---------------------------------------------------------------------------
// Spacer
// ---------------------------------------------------------------------------

export function spacer(heightDxa: number = 200): Paragraph {
  return new Paragraph({
    spacing: { after: heightDxa },
    children: [],
  });
}
