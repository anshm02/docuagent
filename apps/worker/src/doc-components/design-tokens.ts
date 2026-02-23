// ============================================================
// DocuAgent — Document Design Tokens
// Colors, fonts, spacing for .docx generation
// ============================================================

// --- Colors (hex strings for docx) ---

export const colors = {
  primary: "1a56db",       // Blue — headings, links
  primaryLight: "e1effe",  // Light blue — callout backgrounds
  secondary: "374151",     // Dark gray — body text
  heading1: "111827",      // Near-black — H1
  heading2: "1f2937",      // Dark gray — H2
  heading3: "374151",      // Gray — H3
  body: "4b5563",          // Medium gray — body text
  muted: "6b7280",         // Light gray — captions, metadata
  tableBorder: "d1d5db",   // Light gray — table borders
  tableHeader: "f3f4f6",   // Very light gray — table header bg
  tableAlt: "f9fafb",      // Near-white — alternating row bg
  tipBg: "ecfdf5",         // Light green — tip callout bg
  tipBorder: "059669",     // Green — tip border
  warningBg: "fffbeb",     // Light yellow — warning callout bg
  warningBorder: "d97706", // Amber — warning border
  white: "ffffff",
};

// --- Fonts ---

export const fonts = {
  heading: "Calibri",
  body: "Calibri",
  mono: "Consolas",
};

// --- Font sizes (half-points: 24 = 12pt) ---

export const fontSizes = {
  h1: 48,        // 24pt
  h2: 36,        // 18pt
  h3: 28,        // 14pt
  body: 22,      // 11pt
  small: 20,     // 10pt
  caption: 18,   // 9pt
  coverTitle: 72, // 36pt
  coverSubtitle: 32, // 16pt
};

// --- Spacing (DXA units: 1 inch = 1440 DXA, 1 pt = 20 DXA) ---

export const spacing = {
  pageWidth: 12240,     // US Letter width
  pageHeight: 15840,    // US Letter height
  marginTop: 1440,      // 1 inch
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  contentWidth: 9360,   // 12240 - 1440 - 1440 = 9360 DXA (~6.5 inches)

  afterH1: 200,
  afterH2: 160,
  afterH3: 120,
  afterParagraph: 120,
  beforeH1: 360,
  beforeH2: 280,
  beforeH3: 200,

  tableRowHeight: 400,
  tableCellPadding: 80,

  screenshotMaxHeight: 7200, // 5 inches max
};

// --- Line spacing ---

export const lineSpacing = {
  body: 276,   // 1.15x line spacing (240 = single)
  heading: 240, // single
};
