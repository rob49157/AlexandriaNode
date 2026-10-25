const { validateUpload } = require('../services/validation.service');
const { aesEncryptPdf, sealKey } = require('./litProtocol');
const { prepareUpload, postHeader, buildTags, isValidArweaveHash, StorageError } = require('./arweave');
const arweaveConfig = require('../config/arweave');
const spool = require('../services/spool.service');
const { topicForHash } = require('../config/blockchain');
const { registerOnChain, preflight } = require('../services/registration.service');
const { verifyUploadRequest } = require('../services/uploadAuth.service');
const { checkWalletQuota, checkStorageBudget, quotaFor, BUDGET_MESSAGE } = require('../services/uploadQuota.service');
const { isValidWalletAddress } = require('../middleware/auth.middleware');
const prisma = require('../config/db');

function budgetExhausted(res) {
  return res.status(503).json({
    valid: false,
    stage: 'storage',
    reason: 'upload_budget_exhausted',
    message: BUDGET_MESSAGE,
  });
}

// Storage failures before anything is spent: name the cause, because each needs
// a different person to act (an operator, the treasury, or just a retry). Only
// the transient ones tell the user to retry; a StorageError (e.g. bad_tx_id)
// keeps its own code and is a 500, since retrying the same upload cannot fix it.
function storageUnavailable(res, err) {
  if (err instanceof StorageError) {
    return res.status(500).json({
      valid: false,
      stage: 'storage',
      reason: err.code,
      message: `Could not prepare the Arweave upload (${err.message}). Nothing was stored or paid.`,
    });
  }
  const code =
    err.code === 'arweave_price_above_cap'
      ? 'arweave_price_above_cap'
      : err.code === 'arweave_unavailable'
        ? 'arweave_unavailable'
        : 'storage_not_configured';
  const retry = code === 'storage_not_configured' ? '' : ' — please retry later';
  return res.status(503).json({
    valid: false,
    stage: 'storage',
    reason: code,
    message: `Could not prepare the Arweave upload (${err.message}). Nothing was stored or paid${retry}.`,
  });
}

/**
 * Fees signed into headers that are posted but not mined yet. The wallet is
 * charged at mining (Q4: 0 at post, exactly the reward at mining, all four
 * Phase 0 runs), so these are owed but still inside the balance. Counting only
 * this upload's fee let two 150 MiB uploads both pass on a 2.5 AR wallet.
 *
 * A row is counted until the worker records arweaveBlockHeight; for the few
 * seconds between mining and that write its fee is counted twice (deducted AND
 * committed), which can only refuse an upload, never overspend.
 * @returns {Promise<bigint>} winston
 */
async function committedRewardWinston() {
  const rows = await prisma.upload.findMany({
    where: { storageProvider: 'arweave-l1', status: 'pending_confirmation', arweaveBlockHeight: null },
    select: { arweaveReward: true },
  });
  return rows.reduce((sum, r) => sum + BigInt(r.arweaveReward || '0'), 0n);
}

// POST /api/upload
// Orchestration entry point for the upload pipeline.
//
// Validation: Layer 1 (file basics) → Layer 2 (security) → Layer 3 (dedup) → Layer 5 (metadata).
// (Layer 4, AI content analysis, is a separate service and not wired up yet.)
//
// First: the wallet's signature over this exact file, then the upload limits
// (services/uploadQuota.service.js), so a refused upload costs no validation work.
//
// Then: encrypt → sign → check balance and budget → seal → spool → persist → post header → 202.
// The storage worker (services/storage.service.js) finishes the job: chunks,
// confirmations, verified copies, then pending_stake and registration.
//
// ─── Why this order ─────────────────────────────────────────────────────────
// Everything that can fail cheaply fails BEFORE the one step that can cost money
// (a posted header that gets mined):
//
//   signature, limits  4xx/503, nothing spent
//   validate           4xx, nothing spent
//   AES encrypt        local
//   sign Arweave tx    local, free — but yields the arweaveHash (Q1)
//   balance check      the wallet must cover the signed fee, or nothing happens
//   budget check       so must what is left of the 24-hour storage budget
//   seal key           network; failing here still costs nothing
//   spool ciphertext   chunks go out later and must be the same bytes
//   persist row        status pending_confirmation, with the signed header
//   post header       $$ once mined (Q4), permanent
//
// Sealing before posting is the point: reversed, a Lit failure would leave
// paid-for bytes nobody could ever decrypt. Persisting before posting is the
// other half: posted first, a failed DB write would leave a header that may be
// mined and paid for, with no row telling the worker to send its data.
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

    // --- Who is uploading ------------------------------------------------
    // walletAddress is only a claim until the wallet signs for this exact file.
    // Every per-wallet limit below depends on it.
    //
    // multipart/form-data rewrites every line break in a text field as CRLF (the
    // HTML standard's encoding algorithm; measured with fetch + FormData through
    // multer: "\n" arrives as "\r\n"). The wallet signed LF text, so turn the
    // pairs back into what was signed. Safe: a message really signed with CRLF
    // now fails verification, and a lone CR is still refused by the parser.
    const rawMessage = req.body && req.body.authMessage;
    const auth = verifyUploadRequest({
      authMessage: typeof rawMessage === 'string' ? rawMessage.replace(/\r\n/g, '\n') : rawMessage,
      authSignature: req.body && req.body.authSignature,
      fileBuffer: req.file.buffer,
      walletAddress: req.walletAddress,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ valid: false, stage: 'auth', reason: auth.error, message: auth.message });
    }

    // --- Upload limits, before any work is done --------------------------
    const quota = await checkWalletQuota(req.walletAddress);
    if (!quota.ok) {
      return res.status(quota.status).json({
        valid: false,
        stage: 'quota',
        reason: quota.reason,
        message: quota.message,
        awaitingStake: quota.awaiting,
      });
    }
    // The exact fee is known only after signing below; this refuses early when
    // there is no room left at all.
    if (!(await checkStorageBudget(0n)).ok) return budgetExhausted(res);

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

    
    req.file.buffer.fill(0);
    req.file.buffer = null;

    let arweaveHash;
    let litEncryptedKeyId;
    let litDataToEncryptHash;
    let prepared;

    try {
      // --- Sign locally to learn the arweaveHash --------------------------
      // Free and offline. The id is sha256 of the signature, so it is fully
      // determined at signing time (Q1) — no placeholder txid needed.
      const tags = buildTags({
        iv,
        authTag,
        metadata: result.metadata,
        uploader: req.walletAddress,
        sha256Hash: result.sha256Hash,
      });

      try {
        prepared = await prepareUpload(ciphertext, tags);
        arweaveHash = prepared.arweaveHash;
      } catch (err) {
        console.error('[upload] Arweave transaction preparation failed:', err.message);
        return storageUnavailable(res, err);
      }

      // --- The wallet must cover the fee we just signed ------------------
      // ...on top of every fee already signed into a posted-but-unmined header.
      // Caught here, by name, while nothing has been sealed, spooled, or sent.
      // Two requests checking at the same instant can still both pass (neither
      // row exists yet); this closes the common case, not that race.
      try {
        const [balance, committed] = await Promise.all([arweaveConfig.getBalance(), committedRewardWinston()]);
        if (BigInt(balance.winston) - committed < BigInt(prepared.reward)) {
          console.error(
            `[upload] storage wallet ${balance.address} holds ${balance.ar} AR, ` +
              `${arweaveConfig.winstonToAr(committed)} AR of it owed to uploads not mined yet; this upload needs ` +
              `${arweaveConfig.winstonToAr(prepared.reward)} AR. Top it up.`
          );
          return res.status(503).json({
            valid: false,
            stage: 'storage',
            reason: 'storage_wallet_low',
            message: 'The storage wallet cannot cover this upload right now. Nothing was stored or paid — please retry later.',
          });
        }
      } catch (err) {
        console.error('[upload] storage wallet balance check failed:', err.message);
        return storageUnavailable(res, err);
      }

      // --- ...and so must the 24-hour storage budget -----------------------
      const budget = await checkStorageBudget(prepared.reward);
      if (!budget.ok) {
        console.warn(
          `[upload] daily storage budget: ${arweaveConfig.winstonToAr(budget.spentWinston)} of ` +
            `${arweaveConfig.winstonToAr(budget.budgetWinston)} AR used; this upload needs ` +
            `${arweaveConfig.winstonToAr(prepared.reward)} AR. Refused before anything was sealed or posted.`
        );
        return budgetExhausted(res);
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
    } finally {
      // Zero the symmetric key regardless of which branch we left through.
      symmetricKey.fill(0);
    }

    // --- Spool the ciphertext --------------------------------------------
    // The worker sends chunks after the header is mined, possibly after a
    // restart, and they must be these exact bytes.
    try {
      await spool.write(arweaveHash, ciphertext);
    } catch (err) {
      console.error(`[upload] could not spool ciphertext for ${arweaveHash}:`, err.message);
      return res.status(500).json({
        valid: false,
        stage: 'storage',
        reason: 'spool_write_failed',
        message: 'Could not stage the encrypted file for upload. Nothing was stored or paid — please retry.',
      });
    }

    // --- Persist ---------------------------------------------------------
    // Closest match first — checkNearDuplicate ranks them by distance.
    const nearest = (result.nearDuplicateMatches || [])[0];

    try {
      await prisma.upload.create({
        data: {
          arweaveHash,
          // The only key the event listener can join on. Contract events index
          // arweaveHash as a `string`, which Solidity stores as a keccak256
          // topic with the plaintext discarded — so events are matched forwards
          // from this column, never decoded backwards from the log. Omitting it
          // makes the row permanently invisible to on-chain status sync.
          arweaveHashTopic: topicForHash(arweaveHash),
          title: result.metadata.title,
          author: result.metadata.author,
          category: result.metadata.category,
          description: result.metadata.description,
          uploader: req.walletAddress,
          // Owned by the storage worker until the bytes are confirmed and
          // verified on ARWEAVE_MIN_HOLDERS nodes (D9); then pending_stake.
          status: 'pending_confirmation',
          storageProvider: 'arweave-l1',
          arweaveAnchorHeight: prepared.anchorHeight,
          arweaveReward: prepared.reward,
          // The signed header is all the worker needs to re-post it (same id) and
          // to rebuild chunk proofs from the spool. No key material: owner is the
          // public modulus and the signature is public.
          arweaveUploaderState: { v: 1, header: prepared.header, holders: {} },
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
          nearDuplicateDistance: nearest ? nearest.distance : null,
          // Audit trail for the librarian review queue. Written once, here:
          // the plaintext PDF is unavailable after this request, so anything
          // not recorded now is unrecoverable for this book.
          clamavStatus: result.clamavStatus,
          textWordCount: result.textWordCount ?? null,
          textlessPageCount: result.textlessPageCount ?? null,
        },
      });
    } catch (err) {
      // Nothing has been posted yet, so nothing is paid and nothing is lost:
      // drop the spooled ciphertext and let the archivist retry. A unique-key
      // failure here is a concurrent upload of the same file winning the race.
      await spool.remove(arweaveHash).catch(() => {});
      const duplicate = err && err.code === 'P2002';
      console.error(`[upload] index write failed for ${arweaveHash} before posting; nothing spent:`, err.message);
      return res.status(duplicate ? 409 : 500).json({
        valid: false,
        stage: duplicate ? 'dedup' : 'persistence',
        reason: duplicate ? 'exact_duplicate' : 'index_write_failed',
        message: duplicate
          ? 'This exact file was uploaded at the same moment by another request.'
          : 'Could not index the upload. Nothing was stored or paid — please retry.',
      });
    }

    // --- Post the header -------------------------------------------------
    // From here the upload can cost money (once mined). A post that every node
    // refuses is NOT treated as failure: a node may have accepted it and lost the
    // reply. The worker re-posts the same signed header until it is mined or its
    // anchor expires (storage_failed, D1).
    let header = { accepted: [], results: [] };
    try {
      header = await postHeader(prepared.header);
    } catch (err) {
      console.error(`[upload] header post for ${arweaveHash} failed; the storage worker will retry:`, err.message);
    }
    try {
      await prisma.upload.update({
        where: { arweaveHash },
        data: { arweaveTxPostedAt: new Date() },
      });
    } catch (err) {
      console.warn(`[upload] could not record header post time for ${arweaveHash}: ${err.message}`);
    }

    // 202: accepted, not finished. The bytes are confirmed and copied by the
    // storage worker; registration on-chain follows automatically once they are.
    return res.status(202).json({
      valid: true,
      arweaveHash,
      litEncryptedKeyId,
      status: 'pending_confirmation',
      storage: {
        headerAcceptedBy: header.accepted.length,
        reward: prepared.reward,
        rewardAr: arweaveConfig.winstonToAr(prepared.reward),
        confirmationsRequired: arweaveConfig.ARWEAVE_CONFIRMATIONS,
        copiesRequired: arweaveConfig.ARWEAVE_MIN_HOLDERS,
      },
      // Staking needs registerUpload(), which the backend calls only after the
      // bytes are confirmed and verified. Until then stake.stake() would revert.
      nextStep:
        'Storage in progress (usually 30–60 minutes). Poll GET /api/storage/' +
        arweaveHash +
        ' or GET /api/upload/' +
        arweaveHash +
        ' — stake once status is "pending".',
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

// POST /api/upload/:arweaveHash/register
//
// Retry on-chain registration for an upload that is stored and indexed but never
// made it onto the library contract — the backend was unauthorized, out of gas,
// or the RPC was down when the upload landed.
//
// Safe to call repeatedly: registerOnChain checks uploadExists() first, so a
// retry after a timed-out-but-landed transaction reports already_registered
// instead of reverting on the duplicate.
//
// No auth beyond the hash. Registering someone's already-stored upload is not an
// attack — the uploader address comes from the indexed row, not the caller, so
// the worst a stranger can do is pay nothing to advance a row the archivist
// wanted advanced anyway.
async function retryRegistration(req, res, next) {
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
      select: { arweaveHash: true, uploader: true, status: true, title: true, author: true, category: true },
    });

    if (!row) {
      return res.status(404).json({
        error: 'not_found',
        message: `No upload indexed for ${arweaveHash}.`,
      });
    }

    // Registration unlocks staking. Before the bytes are confirmed and verified
    // (D9), an archivist could stake on a book whose data never lands, so the
    // storage worker registers it itself once storage is done.
    if (row.status === 'pending_confirmation' || row.status === 'storage_failed') {
      return res.status(409).json({
        registered: false,
        arweaveHash,
        error: 'storage_not_confirmed',
        status: row.status,
        message:
          row.status === 'storage_failed'
            ? 'This upload was never stored on Arweave. Upload the file again.'
            : 'The file is still being stored on Arweave. It is registered automatically when storage is confirmed.',
      });
    }

    const registration = await registerOnChain(arweaveHash, row.uploader, row);

    if (!registration.registered) {
      // 503, not 400: nothing about the request is wrong. The chain-side
      // precondition (authorization, gas, connectivity) is not met yet.
      return res.status(503).json({
        registered: false,
        arweaveHash,
        error: registration.reason,
        message: registration.message,
      });
    }

    if (registration.txHash) {
      await prisma.upload.updateMany({
        where: { arweaveHash, status: 'pending_stake' },
        data: { status: 'pending', onChainTxHash: registration.txHash },
      });
    }

    return res.json({
      registered: true,
      arweaveHash,
      reason: registration.reason,
      message: registration.message,
      txHash: registration.txHash || null,
      status: 'pending',
      nextStep: 'Approve $ALEX and call stake.stake(arweaveHash, amount) from your wallet.',
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/upload/quota/:address
// What the upload page shows before the archivist picks a file: uploads waiting
// for a stake, uploads in the last 24 hours, and how much of the shared storage
// budget is used. Public: titles and uploaders are public in search anyway.
async function getUploadQuota(req, res, next) {
  try {
    const { address } = req.params;
    if (!isValidWalletAddress(address)) {
      return res.status(400).json({ error: 'invalid_address', message: 'address must be a valid Ethereum address.' });
    }
    return res.json(await quotaFor(address));
  } catch (err) {
    return next(err);
  }
}

// GET /api/upload/registrar/status
// Whether the backend can register uploads on-chain at all, and if not, exactly
// who has to do what about it.
async function getRegistrarStatus(req, res, next) {
  try {
    const check = await preflight();
    return res.status(check.ready ? 200 : 503).json(check);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createUpload,
  getUpload,
  retryRegistration,
  getRegistrarStatus,
  getUploadQuota,
  toPublicUpload,
  PUBLIC_UPLOAD_SELECT,
  storageUnavailable,
};
