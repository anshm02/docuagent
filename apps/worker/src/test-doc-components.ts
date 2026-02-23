// Test script for doc-components: generate a minimal .docx
import "dotenv/config";
import { Document, Packer } from "docx";
import sharp from "sharp";
import { writeFile, stat } from "fs/promises";
import { spacing } from "./doc-components/design-tokens.js";
import {
  h1, h2, h3, paragraph, boldParagraph,
  bulletItem, numberedStep,
  screenshotEmbed, fieldTable,
  tipCallout, warningCallout, navigationBreadcrumb,
  pageBreak, spacer,
} from "./doc-components/components.js";
import {
  coverPage, tableOfContents, productOverviewSection,
  quickStartSection, glossarySection, faqSection,
  confidenceAppendix,
} from "./doc-components/templates.js";

const OUTPUT_PATH = "/tmp/docuagent-test.docx";

async function main() {
  console.log("=== TEST: Doc Components - Minimal .docx Generation ===\n");

  // Create a test 1280x800 solid color PNG
  console.log("Creating test image (1280x800 blue PNG)...");
  const testImage = await sharp({
    create: {
      width: 1280,
      height: 800,
      channels: 4,
      background: { r: 26, g: 86, b: 219, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  console.log(`Test image created: ${testImage.byteLength} bytes`);

  // Build document elements
  const elements = [
    // Cover page
    ...coverPage("Test Application", "February 22, 2026"),

    // TOC
    ...tableOfContents(),

    // Product overview
    ...productOverviewSection("This is a test application for verifying DocuAgent document generation."),

    // Quick start
    ...quickStartSection([
      "Log in to the application",
      "Navigate to the dashboard",
      "Create your first project",
    ]),

    // Content with heading, paragraph, image, table
    pageBreak(),
    h1("Test Section"),
    paragraph("This is a test paragraph with body text to verify font rendering and spacing."),

    h2("Sub-section with Screenshot"),
    paragraph("Below is a test screenshot:"),
    ...screenshotEmbed(testImage, 1280, 800, "Figure 1: Test Screenshot"),

    h3("Field Reference"),
    fieldTable([
      { label: "Name", type: "text", required: true, description: "Enter your full name" },
      { label: "Email", type: "email", required: true, description: "Your email address" },
      { label: "Role", type: "dropdown", required: false, description: "Select your role in the team" },
    ]),

    spacer(200),
    tipCallout("This is a tip callout with helpful information."),
    warningCallout("This is a warning callout about something important."),
    navigationBreadcrumb("Dashboard → Settings → General"),

    h2("List Examples"),
    bulletItem("First bullet point"),
    bulletItem("Second bullet point"),
    bulletItem("Third bullet point"),

    numberedStep(1, "First step in the process"),
    numberedStep(2, "Second step in the process"),
    numberedStep(3, "Third step in the process"),

    // Glossary
    ...glossarySection([
      { term: "Dashboard", definition: "The main overview page showing key metrics and recent activity." },
      { term: "Project", definition: "A workspace for organizing tasks and team collaboration." },
    ]),

    // FAQ
    ...faqSection([
      { question: "How do I create a new project?", answer: "Click the 'New Project' button on the dashboard." },
      { question: "Can I invite team members?", answer: "Yes, go to Settings → Team → Invite Members." },
    ]),

    // Confidence appendix
    ...confidenceAppendix(
      [
        { title: "Dashboard", confidence: 5, notes: "Full code + screenshot analysis" },
        { title: "Settings", confidence: 4, notes: "Screenshot + DOM analysis" },
        { title: "Profile", confidence: 3, notes: "Screenshot only" },
      ],
      80,
    ),
  ];

  // Build document
  console.log("Building document...");
  const doc = new Document({
    styles: {
      default: {
        heading1: {
          run: { bold: true, size: 48, color: "111827", font: "Calibri" },
          paragraph: { spacing: { before: 360, after: 200 } },
        },
        heading2: {
          run: { bold: true, size: 36, color: "1f2937", font: "Calibri" },
          paragraph: { spacing: { before: 280, after: 160 } },
        },
        heading3: {
          run: { bold: true, size: 28, color: "374151", font: "Calibri" },
          paragraph: { spacing: { before: 200, after: 120 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: spacing.pageWidth, height: spacing.pageHeight },
            margin: {
              top: spacing.marginTop,
              bottom: spacing.marginBottom,
              left: spacing.marginLeft,
              right: spacing.marginRight,
            },
          },
        },
        children: elements,
      },
    ],
  });

  // Pack to buffer
  console.log("Packing to buffer...");
  const buffer = await Packer.toBuffer(doc);
  console.log(`Document buffer: ${buffer.byteLength} bytes`);

  // Write to file
  await writeFile(OUTPUT_PATH, buffer);
  const fileStat = await stat(OUTPUT_PATH);
  console.log(`\nFile written: ${OUTPUT_PATH}`);
  console.log(`File size: ${fileStat.size} bytes (${(fileStat.size / 1024).toFixed(1)} KB)`);

  // Verify it's a valid ZIP (docx is a ZIP file)
  // ZIP files start with PK (0x50 0x4B)
  const header = buffer.slice(0, 4);
  const isZip = header[0] === 0x50 && header[1] === 0x4b;
  console.log(`Valid ZIP/DOCX header: ${isZip ? "YES" : "NO"}`);

  if (fileStat.size < 10240) {
    console.error("WARNING: File size seems too small (< 10KB)");
  } else {
    console.log("File size looks reasonable (> 10KB)");
  }

  console.log("\n=== TEST PASSED ===");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
