// Neon integration smoke test: insert, read, and clean up one Upload row.
//
// Run explicitly with:
//   $env:RUN_NEON_DB_TEST = 'true'; npm run test:db
//
// This is opt-in because it writes to the configured DATABASE_URL.

require('dotenv').config();
if (process.env.RUN_NEON_DB_TEST !== 'true') {
  console.error('Refusing to write to the database. Set RUN_NEON_DB_TEST=true to run this test.');
  process.exit(1);
}

if (!process.env.DATABASE_URL || /@host(?::|\/)/.test(process.env.DATABASE_URL)) {
  console.error('DATABASE_URL is missing or still uses the placeholder host.');
  process.exit(1);
}

const crypto = require('node:crypto');
const prisma = require('../config/db');
const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const arweaveHash = `TestUpload_${suffix}`;
const sha256Hash = crypto.createHash('sha256').update(arweaveHash).digest('hex');

const upload = {
  arweaveHash,
  title: `Neon integration test ${suffix}`,
  author: 'Alexandria Test Runner',
  category: 'other',
  description: 'Temporary row created by the Neon Upload integration test.',
  uploader: '0x1234567890abcdef1234567890abcdef12345678',
  status: 'pending_stake',
  fileSize: 128,
  pageCount: 1,
  sha256Hash,
  simHash: '0000000000000000',
  litEncryptedKeyId: `test-key-${suffix}`,
  litDataToEncryptHash: `test-data-hash-${suffix}`,
  encryptionIv: Buffer.alloc(12).toString('base64'),
  encryptionAuthTag: Buffer.alloc(16).toString('base64'),
};
console.log('Inserting Neon Upload row:', upload);

async function main() {
  try {
    console.log('Connecting to Neon database...');
    await prisma.upload.create({ data: upload });
    console.log(upload);
    console.log(`Inserted Neon Upload row with arweaveHash: ${arweaveHash}`);
    const inserted = await prisma.upload.findUnique({
      where: { arweaveHash },
      select: {
        arweaveHash: true,
        title: true,
        status: true,
        fileSize: true,
        sha256Hash: true,
      },
    });
    console.log('Read back Neon Upload row:', inserted);

    if (!inserted) throw new Error('Inserted Upload row could not be read back.');
    if (inserted.title !== upload.title) throw new Error('Upload title did not round-trip.');
    if (inserted.status !== upload.status) throw new Error('Upload status did not round-trip.');
    if (inserted.fileSize !== upload.fileSize) throw new Error('Upload fileSize did not round-trip.');
    if (inserted.sha256Hash !== upload.sha256Hash) throw new Error('Upload sha256Hash did not round-trip.');

    console.log(`PASS: inserted and read Upload ${arweaveHash}`);
  } finally {
    await prisma.upload.deleteMany({ where: { arweaveHash } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('FAIL: Neon Upload integration test:', error.message);
  process.exitCode = 1;
});