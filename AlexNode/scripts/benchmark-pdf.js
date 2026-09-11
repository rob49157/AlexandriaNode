const fs = require('node:fs');
const path = require('node:path');
const { PDFParse } = require('pdf-parse');

const inputPath = process.argv[2];

if (!inputPath) {
  console.error('Usage: node scripts/benchmark-pdf.js <path-to-pdf>');
  process.exit(1);
}

const pdfPath = path.resolve(inputPath);
if (!fs.existsSync(pdfPath)) {
  console.error(`PDF not found: ${pdfPath}`);
  process.exit(1);
}

async function main() {
  const data = fs.readFileSync(pdfPath);
  const started = process.hrtime.bigint();
  const parser = new PDFParse({ data });

  try {
    const result = await parser.getText();
    const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    const peakRssMiB = process.memoryUsage().rss / 1024 / 1024;

    console.log(JSON.stringify({
      file: pdfPath,
      fileSizeMiB: Number((data.length / 1024 / 1024).toFixed(2)),
      pages: result.total || result.pages?.length || 0,
      textCharacters: result.text?.length || 0,
      parseSeconds: Number(elapsedSeconds.toFixed(3)),
      peakRssMiB: Number(peakRssMiB.toFixed(1)),
    }, null, 2));
  } finally {
    await parser.destroy().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`PDF benchmark failed: ${error.message}`);
  process.exitCode = 1;
});