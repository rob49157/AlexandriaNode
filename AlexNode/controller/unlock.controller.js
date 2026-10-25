// POST /api/rental/unlock/:arweaveHash — relay a reader's signed unlock request
// to the decryption Lit Action (KEY-BINDING.md, R3/R4).
//
// ─── Why a relay, and why it is safe ─────────────────────────────────────────
// Every Lit call is metered, and the account balance also pays for sealing keys
// at upload. A Lit key shipped in the browser bundle would let anyone spend that
// balance in a loop. So the key stays here, and requests are checked and
// rate-limited before they cost anything.
//
// The relay never sees a usable book key. The browser makes an RSA key pair for
// each read and names its public half in the message the reader signs; the Action
// wraps the AES key to that public key and nothing else. This backend forwards a
// signed request and receives a wrapped key it cannot open. It cannot swap the
// session key, the book, or the Action either:
//   • the session key and the sealed key are bound inside the signed message
//   • the reader key can only run CIDs the decrypt group permits, and this route
//     also refuses any code whose CID is not LIT_DECRYPT_ACTION_CID
//
// ⚠️ Request and response bodies are never logged. The signature is worthless to
// anyone without the session private key, but there is no reason to keep it.

const crypto = require('crypto');

const prisma = require('../config/db');
const { litApiCall, getLitActionCid, getLitCreditCents, LIT_READER_API_KEY } = require('../config/lit');
const { isValidArweaveHash } = require('./arweave');
const {
  checkReadAccess,
  notRegisteredMessage,
  STAKE_REQUIRED_MESSAGE,
  handleChainError,
} = require('./rental.controller');
const { verifyUnlockRequest } = require('../services/unlockAuth.service');
const { limiterFromEnv, creditGuardFromEnv } = require('../services/unlockRateLimit.service');

const GRANTS = new Set(['rental', 'uploader', 'librarian_review']);
const MAX_CODE_LENGTH = 64_000;

let limiter = limiterFromEnv();
let creditGuard = creditGuardFromEnv(() => getLitCreditCents());

// sha256(code) → CID, so each distinct Action source costs one lookup.
const cidCache = new Map();
const CID_CACHE_SIZE = 16;

async function actionCidFor(code) {
  const digest = crypto.createHash('sha256').update(code).digest('hex');
  if (cidCache.has(digest)) return cidCache.get(digest);
  const cid = await getLitActionCid(code);
  if (cidCache.size >= CID_CACHE_SIZE) cidCache.delete(cidCache.keys().next().value);
  cidCache.set(digest, cid);
  return cid;
}

// The Action's own error codes, mapped to HTTP. Anything unexpected after every
// pre-check passed is the Action's or Lit's fault, not the reader's: 502.
const ACTION_ERROR_STATUS = {
  access_denied: 403,
  bad_signature: 401,
  auth_wallet_mismatch: 401,
  auth_expired: 401,
  auth_not_yet_valid: 401,
  clock_unavailable: 503,
  rpc_disagree: 503,
};

function fail(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function rateLimited(res, result) {
  res.set('Retry-After', String(result.retryAfterSeconds));
  return fail(res, 429, 'rate_limited', `Too many unlock requests. Try again in ${result.retryAfterSeconds} s.`);
}

/** Lit returns { response, logs, has_error }; response may arrive parsed or as a JSON string. */
function actionBody(lit) {
  if (!lit || typeof lit !== 'object' || lit.has_error) return null;
  let body = lit.response;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

async function unlockKey(req, res, next) {
  const { arweaveHash } = req.params;
  if (!isValidArweaveHash(arweaveHash)) {
    return fail(res, 400, 'invalid_hash', 'arweaveHash must be a 43-character base64url transaction ID.');
  }

  const { code, authMessage, authSignature, sessionPublicKey } = req.body || {};
  if (
    typeof code !== 'string' || !code || code.length > MAX_CODE_LENGTH ||
    typeof authMessage !== 'string' || !authMessage || authMessage.length > 2000 ||
    typeof authSignature !== 'string' || authSignature.length > 200 ||
    typeof sessionPublicKey !== 'string' || !sessionPublicKey || sessionPublicKey.length > 2000
  ) {
    return fail(res, 400, 'invalid_request', 'Expected code, authMessage, authSignature and sessionPublicKey.');
  }

  const expectedCid = process.env.LIT_DECRYPT_ACTION_CID;
  if (!LIT_READER_API_KEY || !expectedCid) {
    return fail(res, 503, 'unlock_not_configured', 'LIT_READER_API_KEY and LIT_DECRYPT_ACTION_CID must be set.');
  }

  try {
    const row = await prisma.upload.findUnique({
      where: { arweaveHash },
      select: { arweaveHash: true, uploader: true, status: true, litEncryptedKeyId: true },
    });
    if (!row || !row.litEncryptedKeyId) {
      return fail(res, 404, 'not_found', `No upload indexed for ${arweaveHash}.`);
    }

    // 1. Everything the Action will check except the chain. The sealed key comes
    //    from Postgres, never from the request, so the message must name this book.
    const auth = verifyUnlockRequest({ authMessage, authSignature, sessionPublicKey, sealedKey: row.litEncryptedKeyId });
    if (!auth.ok) return fail(res, auth.status, auth.error, auth.message);

    // 2. Per proven wallet, before any chain read.
    const perWallet = limiter.takeWallet(auth.address);
    if (!perWallet.ok) return rateLimited(res, perWallet);

    // 3. The same gate the Action applies. A stranger costs nothing past here.
    const access = await checkReadAccess(row, auth.address);
    if (access.notRegistered) {
      return fail(res, 409, 'not_registered', notRegisteredMessage(row.status));
    }
    if (access.stakeRequired) {
      return fail(res, 403, 'stake_required', STAKE_REQUIRED_MESSAGE);
    }
    if (access.unavailable) {
      return fail(res, 503, 'rent_contract_paused', 'Rental permission cannot be checked right now — the Rent contract is paused.');
    }
    if (!access.allowed) {
      return fail(res, 403, 'no_active_rental', 'No active rental, ownership, or review window for this wallet.');
    }

    // 4. Only the reviewed Action. The decrypt group enforces this too.
    let cid;
    try {
      cid = await actionCidFor(code);
    } catch (err) {
      console.error(`[unlock] CID lookup failed (${err.status || 'network'})`);
      return fail(res, 502, 'lit_unavailable', 'Lit could not be reached. Try again shortly.');
    }
    if (cid !== expectedCid) {
      return fail(res, 400, 'action_not_permitted', 'This Action version is not the one this server relays.');
    }

    // 5. Only for calls that are about to be paid for: keep the credit uploads
    //    need, then take from the hourly and daily ceilings.
    const credit = await creditGuard.check();
    if (!credit.ok) {
      return fail(res, 503, 'unlock_budget_low', 'Book unlocking is paused while the service tops up its Lit credit. Try again later.');
    }
    const overall = limiter.takeGlobal();
    if (!overall.ok) return rateLimited(res, overall);

    let lit;
    try {
      lit = await litApiCall(
        '/lit_action',
        {
          code,
          js_params: {
            ciphertext: row.litEncryptedKeyId,
            authMessage,
            authSignature,
            sessionPublicKey,
          },
        },
        { apiKey: LIT_READER_API_KEY, privacy: true }
      );
    } catch (err) {
      console.error(`[unlock] Lit request failed (${err.status || 'network'})`);
      return fail(res, 502, 'lit_unavailable', 'Lit could not be reached. Try again shortly.');
    }

    // 6. Forward the Action's answer — and only a wrapped one.
    const body = actionBody(lit);
    if (!body) return fail(res, 502, 'lit_action_failed', 'The decryption Action did not complete.');

    if (Object.prototype.hasOwnProperty.call(body, 'key') || Object.prototype.hasOwnProperty.call(body, 'k')) {
      // An Action that answers with a plain key must never be relayed: this
      // server would then hold book keys. Only a misregistered CID can do this.
      console.error(`[unlock] refused to relay a plain key for ${arweaveHash} — check the decrypt group's CIDs`);
      return fail(res, 502, 'unexpected_action_response', 'The decryption Action answered in an unsafe format.');
    }

    if (typeof body.error === 'string') {
      const reason = /^[a-z_]{1,64}$/.test(body.error) ? body.error : 'action_error';
      return fail(res, ACTION_ERROR_STATUS[reason] || 502, reason, 'The decryption Action refused this request.');
    }

    if (typeof body.wrappedKey !== 'string' || !body.wrappedKey || !GRANTS.has(body.grantedVia)) {
      return fail(res, 502, 'unexpected_action_response', 'The decryption Action answered without a wrapped key.');
    }

    return res.json({ wrappedKey: body.wrappedKey, grantedVia: body.grantedVia });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

/** Tests only: start each case with fresh limits. */
function resetUnlockStateForTests(newLimiter, newCreditGuard) {
  limiter = newLimiter || limiterFromEnv();
  creditGuard = newCreditGuard || creditGuardFromEnv(() => getLitCreditCents());
  cidCache.clear();
}

module.exports = { unlockKey, resetUnlockStateForTests };
