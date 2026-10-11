// Phase 1 test: config/arweave.js — storage wallet, node selection, balance, price.
//
// Run: node tests/arweaveConfig.test.js   (Node >= 22)
//
// No network. global.fetch is replaced with a fake Arweave network whose response
// shapes are the ones observed live on 2026-10-11: /peers is a JSON array of
// "ip:port", /info has `network: "arweave.N.1"` and `height`, and /price and
// /wallet/{addr}/balance answer a bare winston integer as text.
// Wallets are real RSA-4096 JWKs generated into a temp dir, never the real one.
//
// Tests:
//   1-8.   wallet: missing file, bad JSON, wrong key type, public-only key, EVM 0x
//          address, address mismatch, match, key never leaks into errors
//   9-15.  node selection: wrong network, lagging, unreachable, /24 spread,
//          pinned nodes skip discovery, shared discovery, nothing healthy
//  16-23.  balance/price: failover on 5xx and non-numeric 200, all-fail → 503 code,
//          cache invalidated after total failure, input validation, AR formatting

const fs = require('fs');
const os = require('os');
const path = require('path');

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

async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

// ─── Fake network ────────────────────────────────────────────────────────────

const net = { routes: new Map(), calls: [] };

function route(url, handler) {
  net.routes.set(url, handler);
}

global.fetch = async (url) => {
  net.calls.push(url);
  const handler = net.routes.get(url);
  if (!handler) {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    throw err;
  }
  const { status = 200, body } = handler();
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};

const info = (height, network = 'arweave.N.1') => () => ({ body: { network, height, release: 100 } });

// ─── Config loader ───────────────────────────────────────────────────────────

const ENV_KEYS = ['ARWEAVE_WALLET_FILE', 'ARWEAVE_WALLET_ADDRESS', 'ARWEAVE_NODE_URLS', 'ARWEAVE_PEER_SEEDS'];

// config/arweave.js reads env at require time, like the other config modules,
// so each scenario gets a fresh copy.
function loadConfig(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../config/arweave')];
  return require('../config/arweave');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arweave-config-test-'));
const file = (name) => path.join(tmp, name);

(async () => {
  const base = loadConfig({});
  const jwk = await base.offline.wallets.generate();
  const address = await base.offline.wallets.jwkToAddress(jwk);
  fs.writeFileSync(file('wallet.json'), JSON.stringify(jwk));

  // ─── Wallet ──────────────────────────────────────────────────────────────
  console.log('\nWallet');

  let cfg = loadConfig({ ARWEAVE_WALLET_FILE: file('missing.json') });
  let msg = await cfg.validateWallet();
  assert(msg && msg.includes('arweave-wallet-setup.js generate'), '1. Missing file names the setup command');

  fs.writeFileSync(file('garbage.json'), 'not json');
  cfg = loadConfig({ ARWEAVE_WALLET_FILE: file('garbage.json') });
  msg = await cfg.validateWallet();
  assert(msg && msg.includes('not valid JSON'), '2. Non-JSON file is rejected');

  fs.writeFileSync(file('evm.json'), JSON.stringify({ privateKey: '0x' + '1'.repeat(64) }));
  cfg = loadConfig({ ARWEAVE_WALLET_FILE: file('evm.json') });
  msg = await cfg.validateWallet();
  assert(msg && msg.includes('not an Arweave RSA key'), '3. A non-RSA key file is rejected');

  const { kty, n, e } = jwk;
  fs.writeFileSync(file('public.json'), JSON.stringify({ kty, n, e }));
  cfg = loadConfig({ ARWEAVE_WALLET_FILE: file('public.json') });
  msg = await cfg.validateWallet();
  assert(msg && msg.includes('only a PUBLIC key'), '4. Public-only JWK is rejected before it fails at signing');

  cfg = loadConfig({
    ARWEAVE_WALLET_FILE: file('wallet.json'),
    ARWEAVE_WALLET_ADDRESS: '0xccdC69a3020BbaEb5483B2CE20d3fA0c1204b096',
  });
  msg = await cfg.validateWallet();
  assert(msg && msg.includes('Ethereum address'), '5. An EVM 0x address is rejected by name');

  cfg = loadConfig({ ARWEAVE_WALLET_FILE: file('wallet.json'), ARWEAVE_WALLET_ADDRESS: 'x'.repeat(43) });
  msg = await cfg.validateWallet();
  assert(msg && msg.includes(address) && msg.includes('x'.repeat(43)), '6. Address mismatch names both addresses');

  cfg = loadConfig({ ARWEAVE_WALLET_FILE: file('wallet.json'), ARWEAVE_WALLET_ADDRESS: address });
  const w = await cfg.loadWallet();
  assert(w.address === address && /^[A-Za-z0-9_-]{43}$/.test(w.address), '7. Matching address loads; 43-char base64url');

  const allMessages = [];
  for (const name of ['missing.json', 'garbage.json', 'evm.json', 'public.json', 'wallet.json']) {
    cfg = loadConfig({ ARWEAVE_WALLET_FILE: file(name), ARWEAVE_WALLET_ADDRESS: 'y'.repeat(43) });
    allMessages.push(await cfg.validateWallet());
  }
  assert(allMessages.every((m) => m && !m.includes(jwk.d) && !m.includes(jwk.p)), '8. No error message contains private key material');

  // ─── Node selection ──────────────────────────────────────────────────────
  console.log('\nNode selection');

  const peers = [
    '10.0.1.1:1984', // healthy, slow-ish
    '10.0.1.2:1984', // healthy, same /24 as .1.1
    '10.0.2.1:1984', // healthy, different /24
    '10.0.3.1:1984', // wrong network
    '10.0.4.1:1984', // lagging 50 blocks
    '10.0.5.1:1984', // unreachable (no route)
  ];
  const resetNet = () => {
    net.routes.clear();
    net.calls = [];
    route('https://seed.test/peers', () => ({ body: peers }));
    route('http://10.0.1.1:1984/info', info(1000));
    route('http://10.0.1.2:1984/info', info(1000));
    route('http://10.0.2.1:1984/info', info(999));
    route('http://10.0.3.1:1984/info', info(1000, 'arweave.2.9.testnet'));
    route('http://10.0.4.1:1984/info', info(950));
  };
  resetNet();
  cfg = loadConfig({ ARWEAVE_WALLET_FILE: file('wallet.json'), ARWEAVE_PEER_SEEDS: 'https://seed.test' });
  const nodes = await cfg.getNodes();
  assert(!nodes.includes('http://10.0.3.1:1984'), '9. A node on another network is excluded');
  assert(!nodes.includes('http://10.0.4.1:1984'), '10. A node 50 blocks behind is excluded');
  assert(!nodes.includes('http://10.0.5.1:1984'), '11. An unreachable node is excluded');
  assert(
    nodes.length === 3 && nodes.indexOf('http://10.0.2.1:1984') < nodes.indexOf('http://10.0.1.2:1984'),
    '12. One node per /24 comes before a second node from the same /24'
  );

  resetNet();
  route('http://pinned.test:1984/info', info(1000));
  cfg = loadConfig({ ARWEAVE_WALLET_FILE: file('wallet.json'), ARWEAVE_NODE_URLS: 'http://pinned.test:1984', ARWEAVE_PEER_SEEDS: 'https://seed.test' });
  const pinned = await cfg.getNodes();
  assert(
    pinned.length === 1 && pinned[0] === 'http://pinned.test:1984' && !net.calls.includes('https://seed.test/peers'),
    '13. ARWEAVE_NODE_URLS skips discovery entirely'
  );

  // Our own node first (Option B) must stay first, even when a later one is faster.
  net.routes.clear();
  const slow = () => new Promise((r) => setTimeout(r, 40));
  route('http://ours.test:1984/info', info(1000));
  route('http://public.test:1984/info', info(1000));
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (url === 'http://ours.test:1984/info') await slow();
    return realFetch(url);
  };
  cfg = loadConfig({ ARWEAVE_WALLET_FILE: file('wallet.json'), ARWEAVE_NODE_URLS: 'http://ours.test:1984,http://public.test:1984' });
  const ordered = await cfg.getNodes();
  global.fetch = realFetch;
  assert(ordered[0] === 'http://ours.test:1984', '13b. Pinned nodes keep the configured order, not latency order');

  resetNet();
  cfg = loadConfig({ ARWEAVE_WALLET_FILE: file('wallet.json'), ARWEAVE_PEER_SEEDS: 'https://seed.test' });
  await Promise.all([cfg.getNodes(), cfg.getNodes(), cfg.getNodes()]);
  assert(net.calls.filter((c) => c === 'https://seed.test/peers').length === 1, '14. Concurrent callers share one discovery');

  net.routes.clear();
  cfg = loadConfig({ ARWEAVE_WALLET_FILE: file('wallet.json'), ARWEAVE_NODE_URLS: 'http://dead.test:1984' });
  let err = await rejects(cfg.getNodes());
  assert(err && err.code === 'arweave_unavailable', '15. Nothing healthy → arweave_unavailable, not an empty list');

  // ─── Balance and price ───────────────────────────────────────────────────
  console.log('\nBalance and price');

  const twoNodes = () => {
    net.routes.clear();
    net.calls = [];
    route('http://a.test:1984/info', info(1000));
    route('http://b.test:1984/info', info(1000));
  };
  const pinnedTwo = () =>
    loadConfig({ ARWEAVE_WALLET_FILE: file('wallet.json'), ARWEAVE_WALLET_ADDRESS: address, ARWEAVE_NODE_URLS: 'http://a.test:1984,http://b.test:1984' });

  twoNodes();
  route(`http://a.test:1984/wallet/${address}/balance`, () => ({ status: 500, body: 'oops' }));
  route(`http://b.test:1984/wallet/${address}/balance`, () => ({ body: '3000000000000' }));
  cfg = pinnedTwo();
  const bal = await cfg.getBalance();
  assert(
    net.calls.includes(`http://a.test:1984/wallet/${address}/balance`) && bal.winston === '3000000000000' && bal.ar === '3' && bal.node === 'http://b.test:1984',
    '16. Balance tries the first pinned node, then fails over past its 5xx'
  );

  twoNodes();
  route('http://a.test:1984/price/1048576', () => ({ body: '<html>Bad Gateway</html>' }));
  route('http://b.test:1984/price/1048576', () => ({ body: '13530674461' }));
  cfg = pinnedTwo();
  assert((await cfg.getPrice(1048576)) === '13530674461', '17. A 200 with a non-numeric body fails over instead of parsing');

  twoNodes();
  route('http://a.test:1984/price/10', () => ({ status: 503, body: '' }));
  route('http://b.test:1984/price/10', () => ({ body: '' }));
  cfg = pinnedTwo();
  err = await rejects(cfg.getPrice(10));
  assert(err && err.code === 'arweave_unavailable' && err.message.includes('a.test') && err.message.includes('b.test'), '18. Every node failing → arweave_unavailable naming each node');

  const infoCallsBefore = net.calls.filter((c) => c.endsWith('/info')).length;
  route('http://b.test:1984/price/10', () => ({ body: '42' }));
  await cfg.getPrice(10);
  const infoCallsAfter = net.calls.filter((c) => c.endsWith('/info')).length;
  assert(infoCallsAfter > infoCallsBefore, '19. A total failure drops the cached node list, so the next call rediscovers');

  err = await rejects(cfg.getPrice(-1));
  assert(err instanceof TypeError, '20. getPrice rejects a negative size');
  err = await rejects(cfg.getPrice(1.5));
  assert(err instanceof TypeError, '21. getPrice rejects a fractional size');

  assert(
    cfg.winstonToAr('0') === '0' && cfg.winstonToAr('13530674461') === '0.013530674461' && cfg.winstonToAr('2023448219630') === '2.02344821963',
    '22. winstonToAr is exact (BigInt, no float rounding)'
  );

  twoNodes();
  route(`http://a.test:1984/wallet/${address}/balance`, () => ({ body: '0' }));
  route(`http://b.test:1984/wallet/${address}/balance`, () => ({ body: '0' }));
  cfg = pinnedTwo();
  await cfg.getBalance();
  assert(net.calls.every((c) => !c.includes(jwk.d)), '23. Balance requests carry the address only, never key material');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${'='.repeat(50)}\n  Passed: ${passed}\n  Failed: ${failed}\n${'='.repeat(50)}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
