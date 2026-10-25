// POST /api/rental/unlock — the relay between a reader's signed request and the
// decryption Lit Action (KEY-BINDING.md R3/R4).
//
// Run: node tests/unlockRelay.test.js   (or npm run test:unlock)
//
// Lit, Postgres and the chain are stubbed; signatures are real (ethers wallets)
// and session keys are real RSA keys. What this proves:
//   1–4.   A reader with access is forwarded, with the reader key, privacy mode, and
//          the sealed key from Postgres — never one from the request.
//   5–15.  Every request the Action would refuse is refused HERE, before a Lit
//          credit is spent: strangers, borrowed identities, other books, swapped or
//          weak session keys, other sites, expired and overlong windows, paused or
//          unreadable chains, unreviewed Action code.
//   16–19. Rate limits: per proven wallet and global, and the CID lookup cache.
//   20–25. The answer: only a wrapped key is ever relayed, Action errors map to
//          HTTP, and Lit failures are reported without echoing anything.
//   26–30. Configuration and input validation.
//   31.    Nothing the relay logs contains the signature or the message.
//   32–33. A book not registered on-chain yet is a 409, never a Lit call.
//   34–39. The budget: one wallet cannot take every reader's share, a daily
//          ceiling, and a credit reserve that keeps reads from spending what
//          uploads need.

const path = require('path');
const crypto = require('crypto');
const { Wallet } = require('ethers');

process.env.LIT_DECRYPT_ACTION_CID = 'QmReviewedDecryptAction';
process.env.UNLOCK_ALLOWED_DOMAINS = 'localhost:5173';

let passed = 0;
let failed = 0;

function assert(condition, testName, detail) {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ ${testName}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stubs — installed before the controller is required
// ─────────────────────────────────────────────────────────────────────────────

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    path: path.dirname(resolved),
    loaded: true,
    children: [],
    paths: [],
    exports,
  };
  return exports;
}

const WRAPPED = Buffer.from('a key wrapped to the reader session key').toString('base64');

const lit = {
  calls: [],
  cidCalls: 0,
  creditCalls: 0,
  credit: 461, // cents, or an Error to throw
  cidFor: () => 'QmReviewedDecryptAction',
  respond: async () => ({ response: { wrappedKey: WRAPPED, grantedVia: 'uploader' }, logs: '', has_error: false }),
};

stub('../config/lit', {
  LIT_PKP_ID: '0x97ac4b09a4d7cc562e030c75f2054a9d4ce7f2d2',
  LIT_API_KEY: 'upload-key',
  LIT_READER_API_KEY: 'reader-key',
  LIT_API_URL: 'https://api.test.invalid/core/v1',
  litApiCall: async (endpoint, body, options) => {
    lit.calls.push({ endpoint, body, options });
    return lit.respond(endpoint, body, options);
  },
  getLitActionCid: async (code) => {
    lit.cidCalls++;
    return lit.cidFor(code);
  },
  getLitCreditCents: async () => {
    lit.creditCalls++;
    if (lit.credit instanceof Error) throw lit.credit;
    return lit.credit;
  },
  disconnectLit: async () => {},
});

class ChainError extends Error {
  constructor(message, { status = 503, reason = 'chain_unavailable' } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const chain = { rentals: new Set(), paused: false, down: false, librarians: new Set(), unstaked: new Set() };

stub('../services/blockchain.service', {
  ChainError,
  isRentalActive: async (hash, address) => {
    if (chain.down) throw new ChainError('RPC unreachable');
    if (chain.paused) return { active: false, available: false, blacklisted: false, expiry: null };
    return {
      active: chain.rentals.has(`${hash}:${address.toLowerCase()}`),
      available: true,
      blacklisted: false,
      expiry: null,
    };
  },
  isActiveLibrarian: async (address) => ({ active: chain.librarians.has(address.toLowerCase()) }),
  getStakeStatus: async (hash) =>
    chain.unstaked.has(hash)
      ? { staked: false, active: false, challenge: null }
      : { staked: true, active: true, challengePeriodOver: false, staker: ARCHIVIST.address },
  getBookRental: async () => ({}),
  getUploadOnChain: async () => ({ registered: false }),
});

const rows = new Map();
stub('../config/db', {
  upload: {
    findUnique: async ({ where, select }) => {
      const row = rows.get(where.arweaveHash);
      if (!row) return null;
      const out = {};
      for (const key of Object.keys(select)) out[key] = row[key];
      return out;
    },
  },
  $connect: async () => {},
  $disconnect: async () => {},
});

const { unlockKey, resetUnlockStateForTests } = require('../controller/unlock.controller');
const { createUnlockLimiter, createCreditGuard } = require('../services/unlockRateLimit.service');
const { buildUnlockMessage, sha256Hex } = require('../services/unlockAuth.service');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ARCHIVIST = Wallet.createRandom();
const READER = Wallet.createRandom();
const STRANGER = Wallet.createRandom();

const HASH = 'lNpEgp90sz5PoJZkJO0TxPM35psezksrtPsZnTOjPRc';
const OTHER_HASH = '0Nefi7adj5CU0hIYhDsRF3XXT1LGAUwB4i0rfDjSMCA';
const SEALED = 'aba5be55f3035bc4b23144d1051d04ffbb3b1685f7daaa49358fcdab0170a2aa';
const OTHER_SEALED = 'c334831572a50d72a6b7029271c6aea3422c576f76d9e16d975b6d022651bb08';
const ACTION_CODE = 'async function main() { /* the reviewed decryption Action */ }';

const spkiOf = (bits) =>
  crypto.generateKeyPairSync('rsa', { modulusLength: bits }).publicKey.export({ type: 'spki', format: 'der' });
const SPKI = spkiOf(2048);
const OTHER_SPKI = spkiOf(2048);
const WEAK_SPKI = spkiOf(1024);

const iso = (seconds) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function signedBody({
  wallet,
  signer = wallet,
  signedFor = SEALED,
  spki = SPKI,
  sentSpki = spki,
  domain = 'localhost:5173',
  issuedAt = nowSeconds() - 10,
  expiresAt = nowSeconds() + 290,
  code = ACTION_CODE,
  extra = {},
}) {
  const authMessage = buildUnlockMessage({
    domain,
    uri: `http://${domain}`,
    address: wallet.address,
    nonce: 'abcdEFGH12345678',
    issuedAt: iso(issuedAt),
    expirationTime: iso(expiresAt),
    sealedKeyHash: sha256Hex(Buffer.from(signedFor, 'utf8')),
    sessionKeyHash: sha256Hex(spki),
  });
  return {
    code,
    authMessage,
    authSignature: await signer.signMessage(authMessage),
    sessionPublicKey: sentSpki.toString('base64'),
    ...extra,
  };
}

// Everything the controller prints, so the last test can check none of it echoes a request.
const logged = [];

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function call(body, arweaveHash = HASH) {
  const res = makeRes();
  let nextErr = null;
  const originals = { log: console.log, error: console.error, warn: console.warn };
  const capture = (...args) => logged.push(args.map(String).join(' '));
  console.log = console.error = console.warn = capture;
  try {
    await unlockKey({ params: { arweaveHash }, body }, res, (err) => {
      nextErr = err;
    });
  } finally {
    Object.assign(console, originals);
  }
  return { res, nextErr, forwarded: lit.calls.length };
}

const sentBodies = [];

function reset() {
  lit.calls = [];
  lit.cidCalls = 0;
  lit.creditCalls = 0;
  lit.credit = 461;
  lit.cidFor = () => 'QmReviewedDecryptAction';
  lit.respond = async () => ({ response: { wrappedKey: WRAPPED, grantedVia: 'uploader' }, logs: '', has_error: false });
  chain.rentals = new Set([`${HASH}:${READER.address.toLowerCase()}`]);
  chain.paused = false;
  chain.down = false;
  chain.librarians = new Set();
  chain.unstaked = new Set();
  rows.clear();
  rows.set(HASH, { arweaveHash: HASH, uploader: ARCHIVIST.address, status: 'pending', litEncryptedKeyId: SEALED });
  rows.set(OTHER_HASH, { arweaveHash: OTHER_HASH, uploader: ARCHIVIST.address, status: 'approved', litEncryptedKeyId: OTHER_SEALED });
  process.env.LIT_DECRYPT_ACTION_CID = 'QmReviewedDecryptAction';
  // The credit guard is the real one, reading the stubbed balance above.
  resetUnlockStateForTests(createUnlockLimiter({ perWallet: 100, globalPerHour: 1000, globalPerDay: 10_000 }));
}

async function body(options) {
  const b = await signedBody(options);
  sentBodies.push(b);
  return b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  section('A reader with access is forwarded');
  {
    reset();
    const { res, forwarded } = await call(await body({ wallet: ARCHIVIST, extra: { ciphertext: 'ATTACKER-CHOSEN' } }));
    assert(
      res.statusCode === 200 && res.body.wrappedKey === WRAPPED && res.body.grantedVia === 'uploader',
      '1. the uploader gets the wrapped key back unchanged'
    );
    const sent = lit.calls[0];
    assert(
      forwarded === 1 && sent.options.apiKey === 'reader-key' && sent.options.privacy === true,
      '2. forwarded once, with the reader key and X-Privacy-Mode — never the upload key'
    );
    assert(
      sent.body.js_params.ciphertext === SEALED &&
        Object.keys(sent.body.js_params).sort().join(',') === 'authMessage,authSignature,ciphertext,sessionPublicKey',
      '3. the sealed key comes from Postgres, and a ciphertext in the request is ignored'
    );

    reset();
    lit.respond = async () => ({ response: { wrappedKey: WRAPPED, grantedVia: 'rental' }, has_error: false });
    const renter = await call(await body({ wallet: READER }));
    assert(renter.res.statusCode === 200 && renter.forwarded === 1, '4. an active renter is forwarded');
  }

  section('Refused before a Lit credit is spent');
  {
    const refused = async (options, status, error, hash) => {
      reset();
      const { res, forwarded } = await call(await body(options), hash);
      return res.statusCode === status && res.body.error === error && forwarded === 0 && lit.cidCalls === 0;
    };

    assert(await refused({ wallet: STRANGER }, 403, 'no_active_rental'), '5. a stranger (no rental, not the uploader)');
    assert(
      await refused({ wallet: ARCHIVIST, signer: STRANGER }, 401, 'auth_wallet_mismatch'),
      "6. a message naming the archivist, signed by someone else"
    );

    reset();
    const garbage = await body({ wallet: ARCHIVIST });
    garbage.authSignature = `0x${'11'.repeat(65)}`;
    const g = await call(garbage);
    assert(g.res.statusCode === 401 && g.res.body.error === 'bad_signature' && g.forwarded === 0, '7. a signature that recovers nothing');

    assert(
      await refused({ wallet: ARCHIVIST, signedFor: OTHER_SEALED }, 400, 'auth_wrong_key'),
      '8. a signature for another book'
    );
    assert(
      await refused({ wallet: ARCHIVIST, sentSpki: OTHER_SPKI }, 400, 'auth_session_key'),
      '9. a session key other than the signed one (the relay-swap attack)'
    );
    assert(
      await refused({ wallet: ARCHIVIST, spki: WEAK_SPKI }, 400, 'session_key_invalid'),
      '10. a session key under 2048 bits'
    );
    assert(
      await refused({ wallet: ARCHIVIST, domain: 'alexandria-library.example' }, 400, 'auth_domain'),
      '11. a message signed on another site'
    );
    assert(
      await refused(
        { wallet: ARCHIVIST, issuedAt: nowSeconds() - 400, expiresAt: nowSeconds() - 100 },
        401,
        'auth_expired'
      ),
      '12. an expired message'
    );
    assert(
      await refused(
        { wallet: ARCHIVIST, issuedAt: nowSeconds() - 10, expiresAt: nowSeconds() + 3600 },
        400,
        'auth_window_too_long'
      ),
      '13. a window longer than 10 minutes'
    );
    // Uploads may sign for 30 minutes (the file has to arrive first); unlocks
    // must keep the Action's 10, or the relay pays for requests the Action refuses.
    assert(
      await refused(
        { wallet: ARCHIVIST, issuedAt: nowSeconds() - 10, expiresAt: nowSeconds() + 890 },
        400,
        'auth_window_too_long'
      ),
      "13b. a 15-minute unlock window (fine for an upload, not for an unlock)"
    );

    reset();
    chain.paused = true;
    const paused = await call(await body({ wallet: READER }));
    assert(
      paused.res.statusCode === 503 && paused.res.body.error === 'rent_contract_paused' && paused.forwarded === 0,
      '14. a paused Rent contract (cannot tell, so no spend)'
    );

    reset();
    chain.down = true;
    const down = await call(await body({ wallet: READER }));
    assert(down.res.statusCode === 503 && down.forwarded === 0, '15. an unreadable chain');
  }

  section('Only the reviewed Action, and rate limits');
  {
    reset();
    lit.cidFor = () => 'QmSomethingElse';
    const other = await call(await body({ wallet: ARCHIVIST, code: 'async function main() { Lit.Actions.Decrypt(...) }' }));
    assert(
      other.res.statusCode === 400 && other.res.body.error === 'action_not_permitted' && other.forwarded === 0,
      '16. code whose CID is not LIT_DECRYPT_ACTION_CID is never forwarded'
    );

    reset();
    for (let i = 0; i < 3; i++) await call(await body({ wallet: ARCHIVIST }));
    assert(lit.cidCalls === 1 && lit.calls.length === 3, '17. the CID is looked up once per distinct Action source');

    reset();
    resetUnlockStateForTests(
      createUnlockLimiter({ perWallet: 3, perWalletWindowMs: 60_000, globalPerHour: 1000, globalPerDay: 10_000 })
    );
    for (let i = 0; i < 3; i++) await call(await body({ wallet: ARCHIVIST }));
    const limited = await call(await body({ wallet: ARCHIVIST }));
    const otherWallet = await call(await body({ wallet: READER }));
    assert(
      limited.res.statusCode === 429 &&
        limited.res.body.error === 'rate_limited' &&
        Number(limited.res.headers['Retry-After']) > 0 &&
        lit.calls.length === 4,
      '18. a wallet over its limit is refused with Retry-After, and not forwarded'
    );
    assert(otherWallet.res.statusCode === 200, '19. while another wallet is unaffected');

    reset();
    resetUnlockStateForTests(createUnlockLimiter({ perWallet: 100, globalPerHour: 2, globalPerDay: 10_000 }));
    await call(await body({ wallet: ARCHIVIST }));
    await call(await body({ wallet: READER }));
    const ceiling = await call(await body({ wallet: ARCHIVIST }));
    assert(
      ceiling.res.statusCode === 429 && lit.calls.length === 2,
      '20. the global ceiling caps forwarded calls across all wallets'
    );
  }

  section("The Action's answer");
  {
    reset();
    const plainKey = 'UExBSU4tS0VZLUJZVEVTLVRIQVQtTVVTVC1ORVZFUi1MRUFWRQ==';
    // An old or misregistered Action that returns the key in the clear, even
    // alongside a wrapped one, means this server just held a book key. That must
    // fail loudly, not succeed quietly.
    lit.respond = async () => ({
      response: { wrappedKey: WRAPPED, key: plainKey, grantedVia: 'uploader' },
      has_error: false,
    });
    const unsafe = await call(await body({ wallet: ARCHIVIST }));
    assert(
      unsafe.res.statusCode === 502 &&
        unsafe.res.body.error === 'unexpected_action_response' &&
        !JSON.stringify(unsafe.res.body).includes(plainKey) &&
        !logged.some((line) => line.includes(plainKey)),
      '21. a response carrying a plain key is refused outright, never relayed, never logged'
    );

    reset();
    lit.respond = async () => ({ response: JSON.stringify({ error: 'access_denied' }), has_error: false });
    const denied = await call(await body({ wallet: ARCHIVIST }));
    assert(
      denied.res.statusCode === 403 && denied.res.body.error === 'access_denied',
      "22. the Action's own refusal comes back as 403 access_denied"
    );

    reset();
    lit.respond = async () => ({ response: { error: '<script>alert(1)</script>' }, has_error: false });
    const odd = await call(await body({ wallet: ARCHIVIST }));
    assert(odd.res.statusCode === 502 && odd.res.body.error === 'action_error', '23. an unrecognised error code is not echoed');

    reset();
    lit.respond = async () => ({ response: JSON.stringify({ wrappedKey: WRAPPED, grantedVia: 'rental' }), has_error: false });
    const stringForm = await call(await body({ wallet: ARCHIVIST }));
    assert(stringForm.res.statusCode === 200 && stringForm.res.body.grantedVia === 'rental', '24. a response sent as a JSON string is read');

    reset();
    lit.respond = async () => {
      const err = new Error('Lit API /lit_action responded 500: something');
      err.status = 500;
      throw err;
    };
    const litDown = await call(await body({ wallet: ARCHIVIST }));
    assert(litDown.res.statusCode === 502 && litDown.res.body.error === 'lit_unavailable', '25. Lit failing is a 502');
  }

  section('Configuration and input');
  {
    reset();
    delete process.env.LIT_DECRYPT_ACTION_CID;
    const unconfigured = await call(await body({ wallet: ARCHIVIST }));
    assert(
      unconfigured.res.statusCode === 503 && unconfigured.res.body.error === 'unlock_not_configured' && unconfigured.forwarded === 0,
      '26. without LIT_DECRYPT_ACTION_CID the route refuses to relay anything'
    );

    reset();
    const missingBook = await call(await body({ wallet: ARCHIVIST }), 'xNpEgp90sz5PoJZkJO0TxPM35psezksrtPsZnTOjPRc');
    assert(missingBook.res.statusCode === 404, '27. an unindexed book is a 404');

    reset();
    const badHash = await call(await body({ wallet: ARCHIVIST }), 'not-a-hash');
    assert(badHash.res.statusCode === 400 && badHash.res.body.error === 'invalid_hash', '28. a malformed hash is a 400');

    reset();
    const incomplete = await call({ authMessage: 'x', authSignature: '0x' });
    assert(
      incomplete.res.statusCode === 400 && incomplete.res.body.error === 'invalid_request',
      '29. a request missing fields is a 400'
    );

    reset();
    const huge = await body({ wallet: ARCHIVIST });
    huge.code = 'x'.repeat(70_000);
    const tooBig = await call(huge);
    assert(tooBig.res.statusCode === 400 && tooBig.forwarded === 0, '30. oversized Action code is refused');
  }

  section('A book not registered on-chain yet');
  {
    // Postgres knows the uploader from the upload form; the Action reads it from
    // the chain, where an unregistered book reverts. Forwarding would buy a
    // certain refusal, and the archivist would see "Access denied" after signing.
    reset();
    rows.get(HASH).status = 'pending_stake';
    const early = await call(await body({ wallet: ARCHIVIST }));
    assert(
      early.res.statusCode === 409 && early.res.body.error === 'not_registered' &&
        early.forwarded === 0 && lit.cidCalls === 0 && lit.creditCalls === 0,
      '32. the uploader of a pending_stake book gets 409 not_registered, and nothing is spent'
    );

    const refusedAll = [];
    for (const status of ['pending_confirmation', 'storage_failed']) {
      reset();
      rows.get(HASH).status = status;
      const r = await call(await body({ wallet: ARCHIVIST }));
      refusedAll.push(r.res.statusCode === 409 && r.res.body.error === 'not_registered' && r.forwarded === 0);
    }
    assert(refusedAll.every(Boolean), '33. so does a book still being stored, or one whose storage failed');

    // Registration is automatic, so an uploader door without a stake would let
    // anyone upload a PDF, never stake, and read on Alexandria's Lit credit.
    reset();
    chain.unstaked.add(HASH);
    const unstaked = await call(await body({ wallet: ARCHIVIST }));
    assert(
      unstaked.res.statusCode === 403 && unstaked.res.body.error === 'stake_required' &&
        unstaked.forwarded === 0 && lit.cidCalls === 0 && lit.creditCalls === 0,
      '33b. an uploader who never staked the book gets 403 stake_required, and nothing is spent'
    );
  }

  section('The budget');
  {
    // Default limits, one wallet asking once a minute for an hour.
    let t = 0;
    const defaults = createUnlockLimiter({ now: () => t });
    let granted = 0;
    for (let minute = 0; minute < 60; minute++) {
      t = minute * 60_000;
      if (defaults.takeWallet(ARCHIVIST.address).ok) granted++;
    }
    let hourly = 0;
    t = 0;
    while (defaults.takeGlobal().ok) hourly++;
    assert(
      granted * 3 <= hourly,
      '34. with the default limits, one wallet gets at most a third of the hourly ceiling',
      `one wallet: ${granted}/h, ceiling: ${hourly}/h`
    );

    reset();
    resetUnlockStateForTests(createUnlockLimiter({ perWallet: 100, globalPerHour: 1000, globalPerDay: 2 }));
    await call(await body({ wallet: ARCHIVIST }));
    await call(await body({ wallet: READER }));
    const daily = await call(await body({ wallet: ARCHIVIST }));
    assert(
      daily.res.statusCode === 429 && Number(daily.res.headers['Retry-After']) > 0 && lit.calls.length === 2,
      '35. the daily ceiling caps forwarded calls even when the hourly one has room'
    );

    reset();
    lit.credit = 99;
    const before = logged.length;
    const low = await call(await body({ wallet: ARCHIVIST }));
    assert(
      low.res.statusCode === 503 && low.res.body.error === 'unlock_budget_low' && low.forwarded === 0,
      '36. below the 100-cent reserve, unlocks stop before spending, so uploads keep their credit'
    );
    assert(
      logged.slice(before).some((line) => line.includes('below the 100-cent reserve')),
      '37. and the server warns that the account needs topping up'
    );

    reset();
    lit.credit = Object.assign(new Error('Lit API /billing/balance responded 403'), { status: 403 });
    const unknown = await call(await body({ wallet: ARCHIVIST }));
    assert(
      unknown.res.statusCode === 200 && unknown.forwarded === 1 &&
        logged.some((line) => line.includes('could not read the Lit credit balance (403)')),
      '38. an unreadable balance does not lock readers out (the ceilings still bound spend), and is logged'
    );

    reset();
    await call(await body({ wallet: STRANGER }));
    for (let i = 0; i < 3; i++) await call(await body({ wallet: ARCHIVIST }));
    assert(
      lit.calls.length === 3 && lit.creditCalls === 1,
      '39. the balance is read once per refresh, and never for a request refused earlier'
    );

    // The guard on its own: a reading is trusted for its refresh window only.
    let clock = 0;
    let credit = 500;
    const guard = createCreditGuard({ readCreditCents: async () => credit, minCreditCents: 100, refreshMs: 1000, now: () => clock, warn: () => {} });
    const fresh = await guard.check();
    credit = 50;
    const cached = await guard.check();
    clock = 1000;
    const refreshed = await guard.check();
    assert(
      fresh.ok && cached.ok && !refreshed.ok,
      '39b. a low balance takes effect once the cached reading expires'
    );
  }

  section('Logging');
  {
    const echoed = logged.filter((line) =>
      sentBodies.some((b) => line.includes(b.authSignature) || line.includes(b.authMessage.split('\n')[1]))
    );
    assert(echoed.length === 0, '31. nothing the relay logged contains a signature or a requesting address', echoed[0]);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
