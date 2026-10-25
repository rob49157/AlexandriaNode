// KEY-BINDING.md R6 / U2 / U4 — does a key sealed in group 1 open in a new group 2?
//
// Run from the backend folder, in YOUR OWN terminal (the account key is typed at a
// hidden prompt and never written anywhere):
//
//   node --env-file=.env scripts/lit-group-probe.mjs
//
// What it changes on the Lit account:
//   KEPT     group "Alexandria decrypt" with our PKP and no actions (step C reuses it)
//   DELETED  at the end: the test action and the temporary usage key
// Nothing touches group 1 or any real book. The only envelope decrypted holds a
// throwaway random key. The test action returns a yes/no hash comparison, never
// plaintext, so it is harmless even if cleanup fails.
//
// Uses ~10-25 /lit_action calls (about 1 cent each).

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const URL_ = process.env.LIT_API_URL || 'https://api.chipotle.litprotocol.com/core/v1';
const BACKEND_KEY = process.env.LIT_API_KEY;
const PKP = process.env.LIT_PKP_ID;
if (!BACKEND_KEY || !PKP) {
  console.error('LIT_API_KEY / LIT_PKP_ID missing. Run from the backend folder with --env-file=.env');
  process.exit(1);
}
const { keccak256, toUtf8Bytes } = createRequire(path.join(process.cwd(), 'package.json'))('ethers');
const hashCid = (cid) => keccak256(toUtf8Bytes(cid));

const GROUP_NAME = 'Alexandria decrypt';
const POLL_EVERY_MS = 10_000;
const POLL_FOR_MS = 180_000;

// ── secrets never printed ───────────────────────────────────────────────────
const secrets = [BACKEND_KEY];
const redact = (s) => secrets.reduce((acc, k) => (k ? acc.split(k).join('<REDACTED>') : acc), String(s));

function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      console.error('No interactive terminal. Set LIT_ACCOUNT_KEY in this shell instead.');
      process.exit(1);
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value.trim());
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

function promptLine(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(String(d).trim());
    });
  });
}

// ── API ─────────────────────────────────────────────────────────────────────
async function api(key, method, endpoint, body) {
  const res = await fetch(URL_ + endpoint, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Privacy-Mode': 'true' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  // Raw: redacted when printed, so a key added to `secrets` after this call (the
  // temporary usage key, read from this very response) is still hidden.
  return { ok: res.ok, status: res.status, json, text };
}
const runAction = (key, code, js_params) => api(key, 'POST', '/lit_action', { code, js_params });
const log = (label, r) => console.log(`  ${label} -> HTTP ${r.status} ${redact(r.text).slice(0, 400)}`);

function parseResponse(r) {
  let v = r.json && typeof r.json === 'object' ? r.json.response : undefined;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* bare string */ } }
  return v;
}
// "Refused" = the platform would not run it, or Decrypt itself was denied.
function outcome(r) {
  if (!r.ok) return 'refused (HTTP)';
  if (r.json && r.json.has_error) return 'refused (has_error)';
  const v = parseResponse(r);
  if (v && v.decrypted === false) return 'refused (Decrypt threw)';
  if (v && v.decrypted === true) return v.matches ? 'DECRYPTED, matches' : 'DECRYPTED, MISMATCH';
  return 'ran';
}

// ── Action code ─────────────────────────────────────────────────────────────
// Byte-identical to controller/litProtocol.js (registered as alexandria-encrypt-v3).
const ENCRYPT_CODE = [
  'async function main({ pkpId, message }) {',
  '  const result = await Lit.Actions.Encrypt({ pkpId, message });',
  '  Lit.Actions.setResponse({ response: JSON.stringify(result) });',
  '}',
].join('\n');

// Never returns plaintext: only whether it decrypted and whether the hash matches.
const PROBE_CODE = `
async function main({ pkpId, ciphertext, expectedSha256 }) {
  const out = {};
  try {
    const res = await Lit.Actions.Decrypt({ pkpId, ciphertext });
    const str = typeof res === 'string' ? res : JSON.stringify(res);
    out.decrypted = true;
    out.matches = ethers.utils.sha256(ethers.utils.toUtf8Bytes(str)) === expectedSha256;
  } catch (e) {
    out.decrypted = false;
    out.error = String((e && e.message) || e).slice(0, 500);
  }
  Lit.Actions.setResponse({ response: JSON.stringify(out) });
}`.trim();

// Same code, different bytes, so a different CID that is NOT permitted anywhere but `Any`.
const UNPERMITTED_CODE = PROBE_CODE + '\n// unpermitted variant';

// ── Run ─────────────────────────────────────────────────────────────────────
const ACCOUNT_KEY = process.env.LIT_ACCOUNT_KEY || (await promptHidden('Lit ACCOUNT key (hidden): '));
if (!ACCOUNT_KEY) { console.error('No account key.'); process.exit(1); }
secrets.push(ACCOUNT_KEY);

// LIT_API_KEY is a usage key and cannot create groups (KEY-BINDING.md F5), so a run
// with it pays for steps 1-2 and then stops at add_group.
if (ACCOUNT_KEY === BACKEND_KEY) {
  console.error('That is LIT_API_KEY from .env, a usage key. This needs the account key Lit showed once at sign-up.');
  process.exit(1);
}

// Catches a mistyped or revoked key before any Lit call is paid for. It cannot tell
// the account key from a usage key: alex-encrypt may list keys too (live, 2026-10-24).
const keyCheck = await api(ACCOUNT_KEY, 'GET', '/list_api_keys?page_number=0&page_size=100');
if (!keyCheck.ok) {
  log('list_api_keys', keyCheck);
  console.error('Lit refused that key.');
  process.exit(1);
}

console.log('\nThis keeps a group "Alexandria decrypt" (our PKP, no actions) and deletes');
console.log('everything else it creates. About 10-25 Lit calls at ~1 cent each.');
if ((await promptLine('Type yes to continue: ')).toLowerCase() !== 'yes') {
  console.log('Cancelled, nothing was changed. Type the whole word "yes" to run.');
  process.exit(0);
}

const results = {};
let groupId = null;
let probeKey = null;
let probeActionAdded = false;
let strayGroupId = null;
const probeCid = (await api(BACKEND_KEY, 'POST', '/get_lit_action_ipfs_id', PROBE_CODE)).json;
const probeHash = hashCid(probeCid);

try {
  console.log('\nbalance before:', redact((await api(ACCOUNT_KEY, 'GET', '/billing/balance')).text));
  console.log('probe CID      :', probeCid);

  // 1. Seal a throwaway envelope in group 1 with the backend key (the real upload path).
  const envelope = JSON.stringify({ v: 1, k: crypto.randomBytes(32).toString('base64'), arweaveHash: 'u2-probe-not-a-book' });
  const expectedSha256 = '0x' + crypto.createHash('sha256').update(envelope, 'utf8').digest('hex');
  const sealedRes = await runAction(BACKEND_KEY, ENCRYPT_CODE, { pkpId: PKP, message: envelope });
  let sealed = parseResponse(sealedRes);
  if (sealed && typeof sealed === 'object') sealed = sealed.ciphertext || sealed.encryptedSymmetricKey;
  if (typeof sealed !== 'string') { log('seal', sealedRes); throw new Error('sealing failed'); }
  console.log('\n1. Sealed a throwaway envelope in group 1');

  // 2. Baseline: the probe works in group 1 (only because of `Any`). Rules out a broken probe.
  const base = await runAction(BACKEND_KEY, PROBE_CODE, { pkpId: PKP, ciphertext: sealed, expectedSha256 });
  results.baseline = outcome(base);
  console.log('2. Baseline in group 1:', results.baseline);
  if (results.baseline !== 'DECRYPTED, matches') { log('baseline', base); throw new Error('probe does not work even in group 1'); }

  // 3. Group 2 with our PKP and the probe action.
  const groups = await api(ACCOUNT_KEY, 'GET', '/list_groups?page_number=0&page_size=100');
  const existing = Array.isArray(groups.json) ? groups.json.find((g) => g.name === GROUP_NAME) : null;
  if (existing) {
    groupId = Number(BigInt(existing.id));
    console.log(`3. Reusing group "${GROUP_NAME}" (id ${groupId})`);
  } else {
    const g = await api(ACCOUNT_KEY, 'POST', '/add_group', {
      group_name: GROUP_NAME,
      group_description: 'Readers: only the reviewed decryption Action and our PKP',
      pkp_ids_permitted: [],
      cid_hashes_permitted: [],
    });
    log('add_group', g);
    if (!g.ok) throw new Error('add_group failed');
    groupId = Number(BigInt(g.json.group_id));
    console.log(`3. Created group "${GROUP_NAME}" (id ${groupId})`);
  }
  log('add_pkp_to_group', await api(ACCOUNT_KEY, 'POST', '/add_pkp_to_group', { group_id: groupId, pkp_id: PKP }));
  log('add_action', await api(ACCOUNT_KEY, 'POST', '/add_action', {
    action_ipfs_cid: probeCid,
    name: 'alexandria-u2-probe',
    description: 'TEST ONLY, deleted by the script. Returns a hash comparison, never plaintext.',
  }));
  const ag = await api(ACCOUNT_KEY, 'POST', '/add_action_to_group', { group_id: groupId, action_ipfs_cid: probeCid });
  log('add_action_to_group', ag);
  probeActionAdded = ag.ok;

  // 4. A temporary usage key that may execute in group 2 only, with no other rights.
  const k = await api(ACCOUNT_KEY, 'POST', '/add_usage_api_key', {
    name: 'alex-u2-probe',
    description: 'TEMPORARY, deleted by the script',
    can_create_groups: false,
    can_delete_groups: false,
    can_create_pkps: false,
    manage_ipfs_ids_in_groups: [],
    add_pkp_to_groups: [],
    remove_pkp_from_groups: [],
    execute_in_groups: [groupId],
  });
  probeKey = k.json && (k.json.usage_api_key || k.json.api_key);
  if (probeKey) secrets.push(probeKey);
  log('add_usage_api_key', k);
  if (!probeKey) throw new Error('no usage key returned');

  // 5. U2 + U4: run the probe in group 2 until it works or the window ends.
  console.log(`\n5. U2: probe in group 2 (polling every ${POLL_EVERY_MS / 1000}s, up to ${POLL_FOR_MS / 1000}s)`);
  const started = Date.now();
  let last;
  while (Date.now() - started < POLL_FOR_MS) {
    last = await runAction(probeKey, PROBE_CODE, { pkpId: PKP, ciphertext: sealed, expectedSha256 });
    const o = outcome(last);
    console.log(`  +${Math.round((Date.now() - started) / 1000)}s ${o}`);
    if (o.startsWith('DECRYPTED')) { results.u2 = o; results.u4Seconds = Math.round((Date.now() - started) / 1000); break; }
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
  }
  if (!results.u2) { results.u2 = 'NEVER DECRYPTED'; log('last attempt', last); }

  // 6. Negative checks with the group-2-only key.
  const n1 = await runAction(probeKey, UNPERMITTED_CODE, { pkpId: PKP, ciphertext: sealed, expectedSha256 });
  results.n1_unpermittedCode = outcome(n1);
  log('N1 unpermitted code', n1);
  const n2 = await runAction(probeKey, ENCRYPT_CODE, { pkpId: PKP, message: 'n2' });
  results.n2_group1Action = outcome(n2);
  log('N2 group-1 action', n2);
  const n3 = await api(probeKey, 'POST', '/add_group', { group_name: 'should-fail', group_description: '', pkp_ids_permitted: [], cid_hashes_permitted: [] });
  results.n3_createGroup = n3.ok ? 'ALLOWED' : 'refused';
  if (n3.ok && n3.json && n3.json.group_id) strayGroupId = Number(BigInt(n3.json.group_id));
  log('N3 add_group', n3);
} catch (err) {
  console.error('\nSTOPPED:', redact(err.message));
} finally {
  console.log('\nCleanup');
  if (probeKey) log('remove_usage_api_key', await api(ACCOUNT_KEY, 'POST', '/remove_usage_api_key', { usage_api_key: probeKey }));
  if (groupId !== null && probeActionAdded) log('remove_action_from_group', await api(ACCOUNT_KEY, 'POST', '/remove_action_from_group', { group_id: groupId, hashed_cid: probeHash }));
  log('delete_action', await api(ACCOUNT_KEY, 'POST', '/delete_action', { hashed_cid: probeHash }));
  if (strayGroupId !== null) log('remove_group (N3)', await api(ACCOUNT_KEY, 'POST', '/remove_group', { group_id: String(strayGroupId) }));

  console.log('\nState after');
  if (groupId !== null) {
    log(`actions in group ${groupId}`, await api(ACCOUNT_KEY, 'GET', `/list_actions?group_id=${groupId}&page_number=0&page_size=100`));
    log(`wallets in group ${groupId}`, await api(ACCOUNT_KEY, 'GET', `/list_wallets_in_group?group_id=${groupId}&page_number=0&page_size=100`));
  }
  const keys = await api(ACCOUNT_KEY, 'GET', '/list_api_keys?page_number=0&page_size=100');
  console.log('  usage keys:', Array.isArray(keys.json) ? keys.json.map((x) => x.name).join(', ') : redact(keys.text));
  console.log('balance after:', redact((await api(ACCOUNT_KEY, 'GET', '/billing/balance')).text));

  console.log('\nRESULT', JSON.stringify({ groupId, ...results }, null, 2));
  console.log('Expected: u2 "DECRYPTED, matches", n1 and n2 refused, n3 refused.');
}
