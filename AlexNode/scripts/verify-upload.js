#!/usr/bin/env node
// Independently verify that a book really exists across all four systems.
//
//   node scripts/verify-upload.js <arweaveHash>
//   node scripts/verify-upload.js FQ4e7Gt6AB4fSj65bxiyNqrn3Yn2T4nn3dJKKD7ZCx0
//
// Deliberately does NOT go through the upload code path. It queries Arweave, the
// chain, and Postgres directly and cross-checks them against each other, so it
// can contradict the backend rather than echo it. If the upload pipeline had
// lied about anything, this is what would catch it.
//
// Read-only. Sends no transactions, spends nothing, writes nothing.

require('dotenv').config({ quiet: true });

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node ${process.versions.node}: arweave-js 2.x needs Node >= 22. Run: nvm use 22.21.1`);
  process.exit(1);
}

const { ethers } = require('ethers');

const hash = process.argv[2];

if (!hash) {
  console.error('Usage: node scripts/verify-upload.js <arweaveHash>');
  process.exit(1);
}

let ok = 0;
let bad = 0;

function check(condition, label, detail) {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  condition ? ok++ : bad++;
}

(async () => {
  console.log(`\nVerifying ${hash}\n`);

  // ── 1. Arweave (raw nodes, no gateway) ─────────────────────────────────────
  // Read the way the reader does: header signature checked, then every chunk
  // proof-checked against the signed data_root (controller/arweave.js).
  console.log('Arweave (raw mainnet nodes)');
  const arweave = require('../controller/arweave');
  const { ARWEAVE_CONFIRMATIONS } = require('../config/arweave');
  let stored = null;
  try {
    const st = await arweave.getTxStatus(hash);
    check(st.state === 'mined', 'transaction is mined', st.state === 'mined' ? `block ${st.blockHeight}` : st.state);
    if (st.state === 'mined') {
      check(st.confirmations >= ARWEAVE_CONFIRMATIONS, `at least ${ARWEAVE_CONFIRMATIONS} confirmations`, String(st.confirmations));
      stored = await arweave.fetchEncrypted(hash);
      check(stored.length > 0, 'data reads back from raw nodes, every chunk proof-checked', `${stored.length} bytes`);
      check(
        stored.slice(0, 5).toString('latin1') !== '%PDF-',
        'content is NOT a readable PDF (i.e. it is encrypted)',
        `first bytes: ${stored.slice(0, 8).toString('hex')}`
      );
    }
  } catch (err) {
    check(false, 'Arweave nodes reachable', err.message);
  }

  // ── 2. Base Sepolia ────────────────────────────────────────────────────────
  console.log('\nChain (AlexandriaLibrary on Base Sepolia)');
  const { getContracts, CHAIN_ID } = require('../config/blockchain');
  const { library } = getContracts();

  let onChain = null;
  const exists = await library.uploadExists(hash);
  check(exists, 'registered in the library contract', `chain ${CHAIN_ID}`);

  if (exists) {
    onChain = await library.getUpload(hash);
    const STATUS = ['Pending', 'Challenged', 'Approved', 'Rejected'];
    console.log(`    uploader : ${onChain.uploader}`);
    console.log(`    status   : ${STATUS[Number(onChain.status)]}`);
    console.log(`    metadata : ${onChain.metadata}`);
    check(onChain.uploader !== ethers.ZeroAddress, 'has a real uploader address');
    check(Number(onChain.timestamp) > 0, 'has an on-chain timestamp', new Date(Number(onChain.timestamp) * 1000).toISOString());

    // The archivist must be the uploader, not the backend — otherwise
    // stake.stake() (which requires getUploader == msg.sender) is impossible.
    const { BACKEND_WALLET_ADDRESS } = require('../config/blockchain');
    if (BACKEND_WALLET_ADDRESS) {
      check(
        onChain.uploader.toLowerCase() !== BACKEND_WALLET_ADDRESS.toLowerCase(),
        'uploader is the ARCHIVIST, not the backend registrar',
        'otherwise the book could never be staked'
      );
    }
  }

  // ── 3. Postgres ────────────────────────────────────────────────────────────
  console.log('\nPostgres (Neon index)');
  const prisma = require('../config/db');
  const row = await prisma.upload.findUnique({ where: { arweaveHash: hash } });
  check(Boolean(row), 'indexed in Postgres');

  if (row) {
    console.log(`    title    : ${row.title}`);
    console.log(`    status   : ${row.status}`);
    console.log(`    uploader : ${row.uploader}`);
    check(Boolean(row.litEncryptedKeyId), 'sealed Lit key stored');
    check(Boolean(row.encryptionIv && row.encryptionAuthTag), 'AES-GCM IV + auth tag stored');
    check(
      row.arweaveHashTopic === ethers.id(hash),
      'arweaveHashTopic is keccak256 of the hash (event listener join key)'
    );

    if (stored) {
      check(
        stored.length === row.fileSize,
        'stored ciphertext length matches the recorded plaintext size',
        `${stored.length} vs ${row.fileSize} (AES-GCM does not pad)`
      );
    }

    // Cross-check the two sources of truth against each other.
    if (onChain) {
      check(
        row.uploader.toLowerCase() === onChain.uploader.toLowerCase(),
        'Postgres uploader agrees with the chain'
      );
      const meta = JSON.parse(onChain.metadata || '{}');
      check(meta.t === row.title, 'Postgres title agrees with on-chain metadata', `"${meta.t}"`);
    }
  }

  // ── 4. Event listener ──────────────────────────────────────────────────────
  console.log('\nEvent listener');
  const event = await prisma.event.findFirst({
    where: { arweaveHash: hash, eventName: 'UploadRegistered' },
  });
  check(Boolean(event), 'UploadRegistered was synced to Postgres');
  if (event) {
    console.log(`    block    : ${event.blockNumber}`);
    console.log(`    tx       : ${event.transactionHash}`);
    check(
      event.arweaveHashTopic === ethers.id(hash),
      'listener resolved the keccak topic back to this plaintext hash'
    );
    if (row && row.onChainTxHash) {
      check(event.transactionHash === row.onChainTxHash, 'event matches the registration tx on the row');
    }
    console.log(`\n    Cross-check on Basescan:`);
    console.log(`    https://sepolia.basescan.org/tx/${event.transactionHash}`);
  }

  await prisma.$disconnect();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${bad === 0 ? 'VERIFIED ✓' : 'PROBLEMS FOUND ✗'}   ${ok} checks passed, ${bad} failed`);
  console.log(`${'='.repeat(60)}\n`);

  process.exit(bad === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nVerification crashed:', err.message);
  process.exit(1);
});
