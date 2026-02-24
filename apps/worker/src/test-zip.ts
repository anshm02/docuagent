// Test ZIP creation from markdown-generator
import { writeFileSync } from "fs";
import { execSync } from "child_process";

// Inline CRC-32 and ZIP builder from markdown-generator.ts
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function createZipBuffer(files: { path: string; content: Buffer }[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const pathBuf = Buffer.from(file.path, "utf8");
    const content = file.content;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc32(content), 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(pathBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localEntry = Buffer.concat([localHeader, pathBuf, content]);
    localHeaders.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc32(content), 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(pathBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralHeaders.push(Buffer.concat([centralHeader, pathBuf]));
    offset += localEntry.length;
  }

  const centralDir = Buffer.concat(centralHeaders);
  const centralDirOffset = offset;

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDir.length, 12);
  endRecord.writeUInt32LE(centralDirOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, centralDir, endRecord]);
}

// Create test zip
const files = [
  { path: "docs/index.md", content: Buffer.from("# Test Doc\n\nThis is a test.", "utf8") },
  { path: "docs/guide.md", content: Buffer.from("# Guide\n\n1. Step one.\n2. Step two.", "utf8") },
  { path: "docs/images/test.txt", content: Buffer.from("FAKE IMAGE DATA FOR TESTING", "utf8") },
];

const zipBuffer = createZipBuffer(files);
const testPath = "/tmp/docuagent-test.zip";
writeFileSync(testPath, zipBuffer);
console.log(`ZIP created: ${zipBuffer.length} bytes → ${testPath}`);

// Verify with unzip
try {
  const listing = execSync(`unzip -l ${testPath} 2>&1`).toString();
  console.log("\nZIP contents:");
  console.log(listing);

  // Extract and verify
  execSync(`rm -rf /tmp/docuagent-test-extract && mkdir -p /tmp/docuagent-test-extract`);
  execSync(`cd /tmp/docuagent-test-extract && unzip ${testPath} 2>&1`);

  const extracted = execSync(`find /tmp/docuagent-test-extract -type f`).toString().trim();
  console.log("Extracted files:");
  console.log(extracted);

  // Read back content
  const content = execSync(`cat /tmp/docuagent-test-extract/docs/index.md`).toString();
  console.log("\nExtracted index.md content:");
  console.log(content);

  if (content.includes("# Test Doc")) {
    console.log("\nZIP VALIDATION: PASSED");
  } else {
    console.error("\nZIP VALIDATION: FAILED — content mismatch");
    process.exit(1);
  }
} catch (err) {
  console.error("ZIP validation failed:", err);
  process.exit(1);
}
