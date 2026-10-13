// Upload request path: validate → encrypt → sign → balance → seal → spool →
// persist → post header → 202 (direct Arweave L1, ARWEAVE-DIRECT-PLAN.md §4.3).
//
// Run: node tests/uploadFlow.test.js   (Node >= 22)
//
// Lit and Postgres are stubbed. Arweave is NOT: the real config/arweave.js and
// controller/arweave.js run against tests/helpers/fakeArweaveNetwork.js, whose
// responses are copied from real mainnet nodes (Phase 0), with a real RSA-4096
// wallet in a temp dir. Layers 1/2/3/5 run for real.
//
// Every failure case asserts what was spent: nothing may be posted (and so
// nothing can be mined and paid) unless the row and the spool both exist.

require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Arweave = require('arweave');
const { createFakeArweave } = require('./helpers/fakeArweaveNetwork');

let passed = 0;
let failed = 0;
function assert(condition, testName) {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ ${testName}`);
    failed++;
  }
}

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, path: path.dirname(resolved), loaded: true, children: [], paths: [], exports };
  return exports;
}

const NODES = ['http://10.1.1.1:1984', 'http://10.2.1.1:1984', 'http://10.3.1.1:1984'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-flow-'));
const SPOOL = path.join(tmp, 'spool');

(async () => {
  // --- A real wallet, before config/arweave reads env ---------------------
  const jwk = await Arweave.init({}).wallets.generate();
  const walletAddress = await Arweave.init({}).wallets.jwkToAddress(jwk);
  fs.writeFileSync(path.join(tmp, 'wallet.json'), JSON.stringify(jwk));
  Object.assign(process.env, {
    ARWEAVE_WALLET_FILE: path.join(tmp, 'wallet.json'),
    ARWEAVE_WALLET_ADDRESS: walletAddress,
    ARWEAVE_NODE_URLS: NODES.join(','),
    ARWEAVE_SPOOL_DIR: SPOOL,
    ARWEAVE_PEER_CACHE_FILE: path.join(tmp, 'peers.json'),
    ARWEAVE_MAX_REWARD_AR: '3',
    ARWEAVE_REWARD_MARGIN_PERCENT: '0',
  });
  delete process.env.ARWEAVE_PEER_SEEDS;

  const net = createFakeArweave({ nodeUrls: NODES });
  global.fetch = net.fetch;

  // --- Fake Postgres -------------------------------------------------------
  const db = { rows: [], failCreate: null };
  const match = (r, where) => Object.entries(where).every(([k, v]) => r[k] === v);
  stub('../config/db', {
    upload: {
      findUnique: async ({ where }) => db.rows.find((r) => match(r, where)) || null,
      findMany: async () => db.rows,
      create: async ({ data }) => {
        if (db.failCreate) throw db.failCreate;
        db.rows.push({ ...data });
        return data;
      },
      update: async ({ where, data }) => {
        const r = db.rows.find((x) => match(x, where));
        if (!r) throw new Error('not found');
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({ where, data }) => {
        const rows = db.rows.filter((r) => match(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    $connect: async () => {},
    $disconnect: async () => {},
  });

  // Load-bearing: the real service signs real Base Sepolia transactions (an
  // earlier run wrote six junk hashes into the registry for good).
  const registration = { calls: [] };
  stub('../services/registration.service', {
    registerOnChain: async (...args) => {
      registration.calls.push(args);
      return { registered: true, txHash: `0x${'d'.repeat(64)}` };
    },
    preflight: async () => ({ ready: true }),
  });

  // --- Fake Lit ------------------------------------------------------------
  const lit = { calls: 0, fail: false, lastMessage: null };
  stub('../config/lit', {
    LIT_PKP_ID: 'pkp_test_0001',
    LIT_API_KEY: 'test-key',
    LIT_API_URL: 'https://api.test.invalid/core/v1',
    disconnectLit: async () => {},
    litApiCall: async (_endpoint, body) => {
      lit.calls++;
      if (lit.fail) throw new Error('simulated Lit outage');
      lit.lastMessage = body.js_params.message;
      return {
        has_error: false,
        response: JSON.stringify({
          ciphertext: 'SEALED::' + crypto.createHash('sha256').update(lit.lastMessage).digest('hex'),
          dataToEncryptHash: 'dth_' + crypto.randomBytes(8).toString('hex'),
        }),
      };
    },
  });

  const realValidation = require('../services/validation.service');
  let validateOverride = null;
  stub('../services/validation.service', {
    ...realValidation,
    validateUpload: async (file, body) => (validateOverride ? validateOverride(file, body) : realValidation.validateUpload(file, body)),
  });

  const cfg = require('../config/arweave');
  const { createUpload, retryRegistration } = require('../controller/upload.controller');
  const spool = require('../services/spool.service');

  // --- Fixtures ------------------------------------------------------------
  function makePdf(extra = '') {
    return Buffer.from(
      [
        '%PDF-1.4',
        '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
        '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj',
        extra,
        'xref',
        '0 4',
        '0000000000 65535 f ',
        '0000000009 00000 n ',
        '0000000058 00000 n ',
        '0000000115 00000 n ',
        'trailer<</Size 4/Root 1 0 R>>',
        'startxref',
        '190',
        '%%EOF',
      ].join('\n'),
      'latin1'
    );
  }
  const METADATA = {
    title: 'On the Origin of Species',
    author: 'Charles Darwin',
    category: 'science',
    description: 'A foundational work of evolutionary biology, published 1859.',
  };
  const ARCHIVIST = '0x1234567890abcdef1234567890abcdef12345678';
  const mockReq = (pdf, metadata = METADATA) => ({
    file: { originalname: 'book.pdf', mimetype: 'application/pdf', size: pdf.length, buffer: Buffer.from(pdf) },
    body: { ...metadata },
    walletAddress: ARCHIVIST,
  });
  const mockRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (b) => ((res.body = b), res);
    return res;
  };
  async function run(handler, req) {
    const res = mockRes();
    let nextErr = null;
    await handler(req, res, (e) => (nextErr = e));
    if (nextErr) throw nextErr;
    return res;
  }
  const upload = (req) => run(createUpload, req);
  const headerPosts = () => net.callsTo(/^POST \/tx$/).length;
  const spoolFiles = () => (fs.existsSync(SPOOL) ? fs.readdirSync(SPOOL) : []);
  function reset() {
    db.rows = [];
    db.failCreate = null;
    lit.calls = 0;
    lit.fail = false;
    lit.lastMessage = null;
    registration.calls = [];
    validateOverride = null;
    net.calls = [];
    net.price = '13530674461';
    net.balance = '3000000000000';
    for (const n of net.nodes.values()) Object.assign(n, { up: true, postTxMode: 200 });
    fs.rmSync(SPOOL, { recursive: true, force: true });
    cfg._reset();
  }
  const quiet = async (fn) => {
    const e = console.error;
    const w = console.warn;
    console.error = () => {};
    console.warn = () => {};
    try {
      return await fn();
    } finally {
      console.error = e;
      console.warn = w;
    }
  };

  const pdf = makePdf();

  // ── Happy path ───────────────────────────────────────────────────────────
  console.log('\n=== Happy path: 202 pending_confirmation ===\n');
  reset();
  const ok = await upload(mockReq(pdf));
  const row = db.rows[0];
  const hash = ok.body && ok.body.arweaveHash;
  assert(ok.statusCode === 202, `Returns 202 Accepted (got ${ok.statusCode})`);
  assert(ok.body.status === 'pending_confirmation' && row.status === 'pending_confirmation', 'Response and row are pending_confirmation');
  assert(row.storageProvider === 'arweave-l1', 'Row is marked storageProvider = arweave-l1');
  assert(registration.calls.length === 0, 'No on-chain registration in the request: it waits for confirmed storage');
  assert(Boolean(ok.body.litEncryptedKeyId), 'Response carries litEncryptedKeyId');
  assert(ok.body.storage.headerAcceptedBy === 3, 'The signed header was accepted by all 3 nodes');
  // Proves the counter the "nothing posted" checks below rely on actually counts.
  assert(headerPosts() === 3, `headerPosts() sees the 3 posts (got ${headerPosts()}), so a 0 later is meaningful`);
  assert(ok.body.storage.confirmationsRequired === 16 && ok.body.storage.copiesRequired === 2, 'Response states the 16 confirmations / 2 copies rule');
  assert(row.arweaveReward === '13530674461', 'Row records the exact signed fee (D7)');
  assert(Number.isSafeInteger(row.arweaveAnchorHeight), 'Row records the anchor block height (the drop deadline)');
  assert(row.arweaveTxPostedAt instanceof Date, 'Row records when the header was posted');
  assert([0, 1, 2, 3].every((i) => typeof row[`simHashBand${i}`] === 'number'), 'All four simHashBand* columns are written');
  assert(typeof row.arweaveHashTopic === 'string' && row.arweaveHashTopic.startsWith('0x'), 'arweaveHashTopic is written (event listener join key)');

  console.log('\n=== The id, the header, and the envelope ===\n');
  const header = row.arweaveUploaderState.header;
  const sigHash = crypto.createHash('sha256').update(Buffer.from(header.signature, 'base64url')).digest('base64url');
  assert(/^[A-Za-z0-9_-]{43}$/.test(hash), `arweaveHash is 43-char base64url (got "${hash}")`);
  assert(sigHash === hash && header.id === hash, 'arweaveHash = base64url(sha256(signature)) = header.id (Q1)');
  assert(header.data === '', 'The saved header carries no data (chunks are sent separately, Q2)');
  assert(await Arweave.init({}).transactions.verify(new (require('arweave/node/lib/transaction').default)(header)), 'The saved header verifies against its signature');
  assert(header.owner && !JSON.stringify(row.arweaveUploaderState).includes(jwk.d), 'Saved state holds the public key only, never the private key');
  const posted = net.txs.get(hash);
  assert(Boolean(posted) && posted.header.data_root === header.data_root, 'The network received this exact header');

  console.log('\n=== Spool and encryption roundtrip ===\n');
  const spooled = await spool.read(hash);
  const tags = Object.fromEntries(header.tags.map((t) => [Buffer.from(t.name, 'base64url').toString(), Buffer.from(t.value, 'base64url').toString()]));
  const envelope = JSON.parse(lit.lastMessage);
  const key = Buffer.from(envelope.k, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(tags['Encryption-IV'], 'base64'));
  decipher.setAuthTag(Buffer.from(tags['Encryption-Auth-Tag'], 'base64'));
  const plain = Buffer.concat([decipher.update(spooled), decipher.final()]);
  assert(plain.equals(pdf), 'Spooled ciphertext decrypts back to the original PDF byte for byte');
  assert(!spooled.equals(pdf), 'The spool holds ciphertext, never the plaintext');
  const tx = new (require('arweave/node/lib/transaction').default)({ ...header, data: new Uint8Array(0) });
  await tx.prepareChunks(spooled);
  assert(tx.data_root === header.data_root, 'The spool is exactly the data that was signed (data_root matches)');
  assert(row.encryptionIv === tags['Encryption-IV'] && row.encryptionAuthTag === tags['Encryption-Auth-Tag'], 'Postgres IV/authTag match the Arweave tags');
  assert(envelope.arweaveHash === hash && envelope.v === 1 && key.length === 32, 'Sealed envelope is bound to the arweaveHash (KEY-BINDING.md)');
  assert(tags['App-Name'] === 'Alexandria' && tags.Uploader === ARCHIVIST, 'Tags name the app and the archivist');

  // ── Nothing posted (nothing payable) on any pre-post failure ─────────────
  console.log('\n=== Failures before posting cost nothing ===\n');
  reset();
  lit.fail = true;
  let r = await quiet(() => upload(mockReq(pdf)));
  assert(r.statusCode === 502 && r.body.reason === 'lit_unavailable', `Lit failure → 502 lit_unavailable (got ${r.statusCode})`);
  assert(headerPosts() === 0 && db.rows.length === 0 && spoolFiles().length === 0, 'Lit failure: no header posted, no row, no spool');

  reset();
  for (const n of net.nodes.values()) n.up = false;
  r = await quiet(() => upload(mockReq(pdf)));
  assert(r.statusCode === 503 && r.body.reason === 'arweave_unavailable', `No reachable node → 503 arweave_unavailable (got ${r.statusCode} ${r.body.reason})`);
  assert(lit.calls === 0 && db.rows.length === 0, 'Nodes down: Lit never called, nothing persisted');

  reset();
  net.price = String(4n * 10n ** 12n); // 4 AR > the 3 AR cap
  r = await quiet(() => upload(mockReq(pdf)));
  assert(r.statusCode === 503 && r.body.reason === 'arweave_price_above_cap', `Fee above ARWEAVE_MAX_REWARD_AR → 503 (got ${r.body.reason})`);
  assert(headerPosts() === 0 && lit.calls === 0, 'Fee above cap: nothing sealed or posted');

  reset();
  net.balance = '1000';
  r = await quiet(() => upload(mockReq(pdf)));
  assert(r.statusCode === 503 && r.body.reason === 'storage_wallet_low', `Balance below the fee → 503 storage_wallet_low (got ${r.body.reason})`);
  assert(lit.calls === 0 && headerPosts() === 0 && db.rows.length === 0, 'Wallet low: checked before sealing; nothing sealed, posted, or stored');

  // Review 2026-10-12 #5: fees already signed into unmined headers are owed.
  reset();
  const prismaUpload = require('../config/db').upload;
  const findManyAll = prismaUpload.findMany;
  let committedWhere = null;
  // This fake's findMany ignores `where`; filter here so the test checks the
  // query, not just the arithmetic.
  prismaUpload.findMany = async (args) => {
    if (args && args.where && 'arweaveBlockHeight' in args.where) {
      committedWhere = args.where;
      return db.rows.filter((row) => Object.entries(args.where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v)));
    }
    return findManyAll(args);
  };
  net.balance = '20000000000'; // 0.02 AR: covers one 0.0135 AR upload, not two
  const owed = { storageProvider: 'arweave-l1', status: 'pending_confirmation', arweaveReward: '13530674461' };
  db.rows.push({ ...owed, arweaveHash: 'owed-not-mined' });
  r = await quiet(() => upload(mockReq(pdf)));
  assert(r.statusCode === 503 && r.body.reason === 'storage_wallet_low', `A second upload the balance covers only before counting the first's unmined fee → storage_wallet_low (got ${r.statusCode} ${r.body.reason})`);
  assert(lit.calls === 0 && headerPosts() === 0, 'Refused before sealing or posting');
  assert(
    committedWhere && committedWhere.status === 'pending_confirmation' && committedWhere.arweaveBlockHeight === null && committedWhere.storageProvider === 'arweave-l1',
    'Only posted-but-unmined direct-path uploads count as owed'
  );
  reset();
  net.balance = '20000000000';
  db.rows.push({ ...owed, arweaveHash: 'already-mined', arweaveBlockHeight: 2_020_000 }); // fee already deducted
  r = await quiet(() => upload(mockReq(pdf)));
  assert(r.statusCode === 202, `A mined upload's fee is already out of the balance, so it is not counted again (got ${r.statusCode} ${r.body.reason})`);
  prismaUpload.findMany = findManyAll;

  // Review 2026-10-12 #6: only transient failures tell the user to retry.
  const { storageUnavailable } = require('../controller/upload.controller');
  const { StorageError } = require('../controller/arweave');
  const fakeRes = () => ({ statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  let sr = storageUnavailable(fakeRes(), new StorageError('bad_tx_id', 'id mismatch'));
  assert(sr.statusCode === 500 && sr.body.reason === 'bad_tx_id' && !/retry/.test(sr.body.message), 'A StorageError keeps its own code (bad_tx_id), is a 500, and does not say "retry"');
  sr = storageUnavailable(fakeRes(), new Error('No Arweave wallet at /x'));
  assert(sr.statusCode === 503 && sr.body.reason === 'storage_not_configured' && !/retry/.test(sr.body.message), 'Missing wallet → storage_not_configured, without "retry"');
  sr = storageUnavailable(fakeRes(), Object.assign(new Error('nodes down'), { code: 'arweave_unavailable' }));
  assert(sr.body.reason === 'arweave_unavailable' && /retry/.test(sr.body.message), 'arweave_unavailable still says to retry');

  reset();
  db.failCreate = new Error('simulated Neon outage');
  r = await quiet(() => upload(mockReq(pdf)));
  assert(r.statusCode === 500 && r.body.reason === 'index_write_failed', `DB failure → 500 index_write_failed (got ${r.statusCode})`);
  assert(headerPosts() === 0, 'DB failure: header NOT posted, so it can never be mined and paid for');
  assert(spoolFiles().length === 0, 'DB failure: the spooled ciphertext is removed');

  reset();
  db.failCreate = Object.assign(new Error('Unique constraint failed on sha256Hash'), { code: 'P2002' });
  r = await quiet(() => upload(mockReq(pdf)));
  assert(r.statusCode === 409 && r.body.reason === 'exact_duplicate', 'A concurrent duplicate losing the insert race → 409, nothing posted');

  // ── Header refused everywhere is not a failure ───────────────────────────
  console.log('\n=== Header refused by every node ===\n');
  reset();
  for (const n of net.nodes.values()) n.postTxMode = 500;
  r = await quiet(() => upload(mockReq(pdf)));
  assert(r.statusCode === 202 && r.body.storage.headerAcceptedBy === 0, 'Still 202: a node may have accepted and lost the reply; the worker re-posts');
  assert(db.rows.length === 1 && spoolFiles().length === 1, 'Row and spool are kept for the worker');

  // ── Dedup ────────────────────────────────────────────────────────────────
  console.log('\n=== Deduplication ===\n');
  reset();
  const { computeSha256 } = require('../services/dedup.service');
  db.rows.push({ arweaveHash: 'PreExistingHash0000000000000000000000000000', title: 'Already Archived', sha256Hash: computeSha256(pdf), simHash: '0000000000000000' });
  r = await upload(mockReq(pdf));
  assert(r.statusCode === 409 && r.body.reason === 'exact_duplicate', 'Exact duplicate → 409');
  assert(lit.calls === 0 && headerPosts() === 0 && net.callsTo(/tx_anchor/).length === 0, 'Exact duplicate: Lit and Arweave never touched');

  reset();
  validateOverride = async () => ({
    valid: true,
    pageCount: 1,
    metadata: { ...METADATA },
    sha256Hash: crypto.randomBytes(32).toString('hex'),
    simHash: 'ffffffffffffffff',
    simHashBands: { simHashBand0: 65535, simHashBand1: 65535, simHashBand2: 65535, simHashBand3: 65535 },
    isNearDuplicate: true,
    nearDuplicateMatches: [{ arweaveHash: 'NeighbourHash000000000000000000000000000000', title: 'A Close Match', distance: 2, similarity: 96.9 }],
    clamavSkipped: true,
    clamavStatus: 'unavailable',
    textWordCount: 4200,
    textlessPageCount: 0,
  });
  r = await upload(mockReq(pdf));
  assert(r.statusCode === 202 && r.body.isNearDuplicate === true, 'Near-duplicate is accepted and flagged');
  assert(db.rows[0].nearDuplicateOf === 'NeighbourHash000000000000000000000000000000' && db.rows[0].nearDuplicateDistance === 2, 'Row records the closest match and its distance');
  assert(db.rows[0].clamavStatus === 'unavailable' && db.rows[0].textWordCount === 4200, 'Audit fields are recorded');

  // ── Tags fit Arweave's 2048-byte limit even for 4-byte UTF-8 ─────────────
  console.log('\n=== Tag byte budget ===\n');
  reset();
  const wide = '𝔄'.repeat(200); // 4 bytes each: 800 bytes per field before capping
  validateOverride = async () => ({
    valid: true,
    pageCount: 1,
    metadata: { title: wide, author: wide, category: wide, description: 'd' },
    sha256Hash: crypto.randomBytes(32).toString('hex'),
    simHash: '0000000000000000',
    simHashBands: { simHashBand0: 0, simHashBand1: 0, simHashBand2: 0, simHashBand3: 0 },
    isNearDuplicate: false,
    nearDuplicateMatches: [],
  });
  r = await upload(mockReq(pdf));
  const wideHeader = db.rows[0] && db.rows[0].arweaveUploaderState.header;
  const tagBytes = wideHeader
    ? wideHeader.tags.reduce((n, t) => n + Buffer.from(t.name, 'base64url').length + Buffer.from(t.value, 'base64url').length, 0)
    : Infinity;
  assert(r.statusCode === 202 && tagBytes <= 2048, `Tags stay within 2048 bytes with 4-byte characters (${tagBytes} bytes)`);
  const wideTitle = wideHeader && Buffer.from(wideHeader.tags.find((t) => Buffer.from(t.name, 'base64url').toString() === 'Title').value, 'base64url').toString();
  assert(wideTitle && !wideTitle.includes('�'), 'Truncation never splits a UTF-8 character');

  // ── Anchor height fallback ───────────────────────────────────────────────
  console.log('\n=== Anchor height ===\n');
  reset();
  const realGet = net.anchors.get.bind(net.anchors);
  net.anchors.get = (k) => realGet(k);
  r = await upload(mockReq(pdf));
  assert(db.rows[0].arweaveAnchorHeight === net.height, 'Anchor height is the anchor block\'s own height');

  // ── Registration retry is refused until storage is confirmed ─────────────
  console.log('\n=== Registration retry gating ===\n');
  reset();
  r = await upload(mockReq(pdf));
  const pendingHash = r.body.arweaveHash;
  const retry = await run(retryRegistration, { params: { arweaveHash: pendingHash } });
  assert(retry.statusCode === 409 && retry.body.error === 'storage_not_confirmed', 'Registration of a pending_confirmation upload → 409 storage_not_confirmed');
  assert(registration.calls.length === 0, 'No registration attempted for unconfirmed storage');
  db.rows[0].status = 'storage_failed';
  const retry2 = await run(retryRegistration, { params: { arweaveHash: pendingHash } });
  assert(retry2.statusCode === 409 && /upload the file again/i.test(retry2.body.message), 'storage_failed → 409 telling the archivist to re-upload');

  // ── Plaintext is zeroed ──────────────────────────────────────────────────
  console.log('\n=== Plaintext handling ===\n');
  reset();
  const req = mockReq(pdf);
  const original = req.file.buffer;
  await upload(req);
  assert(req.file.buffer === null && original.every((b) => b === 0), 'The plaintext PDF buffer is zeroed and dropped');

  // ── Guard: tests never sign a real chain transaction ─────────────────────
  console.log('\n=== Chain-write guard ===\n');
  const realChainConfig = require('../config/blockchain');
  assert(realChainConfig.chainWritesBlocked() !== null, 'config/blockchain refuses to sign from a test entrypoint');
  assert(realChainConfig.getSigner() === null, 'getSigner() returns null under a test entrypoint');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${'='.repeat(50)}\nRESULT: ${failed === 0 ? 'ALL PASSED ✓' : 'SOME FAILED ✗'}\n  Passed: ${passed}\n  Failed: ${failed}\n${'='.repeat(50)}\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
