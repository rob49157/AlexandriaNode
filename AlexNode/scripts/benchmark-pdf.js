const fs = require('node:fs');
const path = require('node:path');
const { PDFParse } = require('pdf-parse');
const { countWords } = require('../services/validation.service');

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
    // Same options as validateLayer1, so the word counts printed here are the
    // ones an upload of this file would record. See services/validation.service.js.
    const result = await parser.getText({ pageJoiner: '' });
    const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    const peakRssMiB = process.memoryUsage().rss / 1024 / 1024;

    const pages = result.total || result.pages?.length || 0;
    const { textWordCount, textlessPageCount } = countWords(result.pages);

    console.log(JSON.stringify({
      file: pdfPath,
      fileSizeMiB: Number((data.length / 1024 / 1024).toFixed(2)),
      pages,
      textCharacters: result.text?.length || 0,
      // A scan with no OCR lands here as 0 words and textlessPages === pages.
      textWordCount,
      wordsPerPage: pages ? Math.round(textWordCount / pages) : 0,
      textlessPageCount,
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