const { validateUpload } = require('../services/validation.service');
const { aesEncryptPdf, sealKey } = require('./litProtocol');
const { prepareUpload, commitUpload, buildTags, isValidArweaveHash } = require('./arweave');
const prisma = require('../config/db');

// POST /api/upload
// Orchestration entry point for the upload pipeline.
//
// Validation: Layer 1 (file basics) → Layer 2 (security) → Layer 3 (dedup) → Layer 5 (metadata).
// (Layer 4, AI content analysis, is a separate service and not wired up yet.)
//
// Then: encrypt → sign → seal → upload → persist.
//
// ─── Why this order ─────────────────────────────────────────────────────────
// Everything that can fail cheaply is made to fail BEFORE the one step that
// costs money and cannot be undone (the Irys push):
//
//   validate           4xx, nothing spent
//   AES encrypt        local
//   sign Irys tx       local, free — but yields the arweaveHash
//   seal key           network; failing here still costs nothing
//   push to Arweave    $$, permanent, irreversible
//   persist to Postgres
//
// Sealing before pushing is the point. Reversed, a Lit failure would leave
// permanently paid-for bytes that nobody could ever decrypt.
async function createUpload(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({
        valid: false,
        stage: 'file_basics',
        reason: 'missing_file',
        message: 'No PDF file received. Send it as multipart/form-data under the "file" field.',
      });
    }

    // Layers 1 + 2 + 3 + 5. Returns the first failing check, or a success
    // object with sanitized metadata, page count, hashes, and dedup flags.
    const result = await validateUpload(req.file, req.body);
    if (!result.valid) {
      const { httpStatus = 400, valid, stage, reason, message } = result;
      return res.status(httpStatus).json({ valid, stage, reason, message });
    }

    const fileSize = req.file.size;

    // --- Encrypt (Layer 1 of the envelope) --------------------------------
    // symmetricKey is live from here until it is zeroed below.
    const { ciphertext, iv, authTag, symmetricKey } = aesEncryptPdf(req.file.buffer);

    // The plaintext PDF has served its purpose. Drop it as early as possible —
    // CLAUDE.md forbids unencrypted PDFs living any longer than necessary, and
    // this also releases the larger of the two buffers before the network waits.
    req.file.buffer.fill(0);
    req.file.buffer = null;

    let arweaveHash;
    let litEncryptedKeyId;
    let litDataToEncryptHash;

    try {
      // --- Sign locally to learn the arweaveHash --------------------------
      // Free and offline. A data item's id is sha256 of its signature, so it is
      // fully determined at signing time — no placeholder txid needed.
      const tags = buildTags({
        iv,
        authTag,
        metadata: result.metadata,
        uploader: req.walletAddress,
        sha256Hash: result.sha256Hash,
      });

      let tx;
      try {
        ({ arweaveHash, tx } = await prepareUpload(ciphertext, tags));
      } catch (err) {
        console.error('[upload] Irys transaction preparation failed:', err.message);
        return res.status(502).json({
          valid: false,
          stage: 'storage',
          reason: 'irys_unavailable',
          message: 'Could not prepare the Arweave upload. Nothing was stored — please retry.',
        });
      }

      // --- Seal the key, bound to that hash (Layer 2 of the envelope) -----
      try {
        ({
          encryptedSymmetricKey: litEncryptedKeyId,
          dataToEncryptHash: litDataToEncryptHash,
        } = await sealKey(symmetricKey, arweaveHash));
      } catch (err) {
        console.error('[upload] Lit key sealing failed:', err.message);
        return res.status(502).json({
          valid: false,
          stage: 'encryption',
          reason: 'lit_unavailable',
          message: 'Could not encrypt the file key. Nothing was stored — please retry.',
        });
      }

      // --- Push the bytes. Paid and irreversible from here on. ------------
      try {
        await commitUpload(tx, arweaveHash);
      } catch (err) {
        console.error('[upload] Irys upload failed:', err.message);
        return res.status(502).json({
          valid: false,
          stage: 'storage',
          reason: 'arweave_upload_failed',
          message: 'Could not store the file on Arweave. Nothing was persisted — please retry.',
        });
      }
    } finally {
      // Zero the symmetric key regardless of which branch we left through.
      symmetricKey.fill(0);
    }

    // --- Persist ---------------------------------------------------------
    const nearest = (result.nearDuplicateMatches || [])[0];

    try {
      await prisma.upload.create({
        data: {
          arweaveHash,
          title: result.metadata.title,
          author: result.metadata.author,
          category: result.metadata.category,
          description: result.metadata.description,
          uploader: req.walletAddress,
          status: 'pending_stake',
          fileSize,
          pageCount: result.pageCount,
          sha256Hash: result.sha256Hash,
          simHash: result.simHash,
          // MUST travel with simHash — without these indexed band columns the
          // row is invisible to the banded-LSH near-duplicate prefilter forever.
          // It fails silently, not loudly. See services/dedup.service.js.
          ...result.simHashBands,
          litEncryptedKeyId,
          litDataToEncryptHash,
          encryptionIv: iv.toString('base64'),
          encryptionAuthTag: authTag.toString('base64'),
          isNearDuplicate: Boolean(result.isNearDuplicate),
          nearDuplicateOf: nearest ? nearest.arweaveHash : null,
        },
      });
    } catch (err) {
      // The only lossy case: storage is paid for and permanent, but the index
      // row is missing. No funds lost and no state corruption — but the row has
      // to be reconstructable by hand, so log everything needed to rebuild it.
      console.error(
        '[upload] [ORPHAN] Arweave upload succeeded but the Postgres row failed to write. ' +
          'Recover with: ' +
          JSON.stringify({
            arweaveHash,
            litEncryptedKeyId,
            litDataToEncryptHash,
            uploader: req.walletAddress,
            sha256Hash: result.sha256Hash,
            encryptionIv: iv.toString('base64'),
            encryptionAuthTag: authTag.toString('base64'),
          }),
        err
      );

      return res.status(500).json({
        valid: false,
        stage: 'persistence',
        reason: 'index_write_failed',
        message:
          'The file was stored on Arweave but could not be indexed. Keep this arweaveHash — ' +
          'the upload can be recovered and staked with it.',
        arweaveHash,
      });
    }

    return res.status(201).json({
      valid: true,
      arweaveHash,
      litEncryptedKeyId,
      status: 'pending_stake',
      isNearDuplicate: Boolean(result.isNearDuplicate),
      nearDuplicateMatches: result.nearDuplicateMatches || [],
      clamavSkipped: result.clamavSkipped,
    });
  } catch (err) {
    return next(err);
  }
}

// ─── Public read shape ───────────────────────────────────────────────────────
// Read endpoints are unauthenticated, so the row is projected down to the
// fields a catalogue browser needs. What is deliberately left out:
//
//   litEncryptedKeyId / litDataToEncryptHash
//       The sealed key envelope — exactly the ciphertext an attacker needs in
//       hand before a Lit Action gate is the only thing left between them and
//       the book. The gate is meant to hold on its own, but there is no reason
//       to hand out the material for free. It belongs behind the rental-gated
//       decrypt-params route (Phase 6b), not here.
//
//   encryptionIv / encryptionAuthTag
//       Useless without the key above, and already public in the Arweave tags.
//       Shipped alongside the sealed key on that same rental-gated route, so
//       the frontend gets one complete decryption payload instead of two halves.
//
//   sha256Hash / simHash / simHashBand0..3
//       Dedup internals. Publishing sha256Hash in particular turns this route
//       into an oracle for "does Alexandria already hold this exact file?",
//       which is a probe worth denying.
function toPublicUpload(row) {
  return {
    arweaveHash: row.arweaveHash,
    title: row.title,
    author: row.author,
    category: row.category,
    description: row.description,
    uploader: row.uploader,
    uploadTimestamp: row.uploadTimestamp,
    status: row.status,
    fileSize: row.fileSize,
    pageCount: row.pageCount ?? null,
    isNearDuplicate: Boolean(row.isNearDuplicate),
    nearDuplicateOf: row.nearDuplicateOf ?? null,
    onChainTxHash: row.onChainTxHash ?? null,
  };
}

// The columns toPublicUpload reads. Passed to Prisma as an explicit `select` so
// key material never leaves Postgres in the first place — a later edit to the
// serializer cannot accidentally start leaking a field the query never fetched.
const PUBLIC_UPLOAD_SELECT = {
  arweaveHash: true,
  title: true,
  author: true,
  category: true,
  description: true,
  uploader: true,
  uploadTimestamp: true,
  status: true,
  fileSize: true,
  pageCount: true,
  isNearDuplicate: true,
  nearDuplicateOf: true,
  onChainTxHash: true,
};

// GET /api/upload/:arweaveHash
// Metadata lookup for a single upload, by transaction ID.
//
// Returns rows in any status, including "pending_stake" — an archivist who
// closed the browser mid-flow needs to look their hash back up to finish
// staking, and they only have the hash to go on. Search is the surface that
// filters by status; this one is a direct lookup of a known identifier.
async function getUpload(req, res, next) {
  try {
    const { arweaveHash } = req.params;

    if (!isValidArweaveHash(arweaveHash)) {
      return res.status(400).json({
        error: 'invalid_hash',
        message: 'arweaveHash must be a 43-character base64url transaction ID.',
      });
    }

    const row = await prisma.upload.findUnique({
      where: { arweaveHash },
      select: PUBLIC_UPLOAD_SELECT,
    });

    if (!row) {
      return res.status(404).json({
        error: 'not_found',
        message: `No upload indexed for ${arweaveHash}.`,
      });
    }

    return res.json(toPublicUpload(row));
  } catch (err) {
    return next(err);
  }
}

module.exports = { createUpload, getUpload, toPublicUpload, PUBLIC_UPLOAD_SELECT };
