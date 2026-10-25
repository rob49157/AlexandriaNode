// Set up a NEW Lit account for Alexandria, already locked down (KEY-BINDING.md
// steps C/D). The old account's master key was never saved, so its groups and keys
// could not be fixed; it held dummy data only and is abandoned (2026-10-24).
//
// Creates:
//   group "Alexandria encrypt"  our PKP + the encrypt Action. No `Any` (F3).
//   group "Alexandria decrypt"  our PKP. The decrypt Action is added afterwards by the
//                               frontend's `npm run lit:register -- --register`, because
//                               its source embeds the PKP id this script mints.
//   usage key alex-encrypt      executes in "Alexandria encrypt" only, no other right (F5)
//   usage key alex-reader       executes in "Alexandria decrypt" only, no other right
//
// Then tests it live: sealing works (T1); a key sealed in one group opens in the
// other (U2); the upload key cannot run code its group does not permit (F3); the
// reader key cannot run other code (N1, N2); neither key can manage groups (N3, N4).
//
// Run from the backend folder, in YOUR OWN terminal, WITHOUT --env-file: the LIT_*
// values in .env belong to the old account.
//
//   node scripts/lit-new-account.mjs [--pkp 0x…]
//
// --pkp reuses a PKP minted by an earlier run instead of minting another.
//
// The account key is typed at a hidden prompt and never written anywhere. The new
// usage keys and PKP id go straight into .env (LIT_API_KEY, LIT_READER_API_KEY,
// LIT_PKP_ID) and are never printed; every key is redacted from the output.
//
// Needs credit on the new account. Uses ~10-30 /lit_action calls (about 1 cent each).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { keccak256, toUtf8Bytes } = require('ethers');
// The exact source the backend seals with, so the registered CID is the one it runs.
const { LIT_ENCRYPT_ACTION_CODE: ENCRYPT_CODE } = require('../controller/litProtocol.js');

const URL_ = process.env.LIT_API_URL || 'https://api.chipotle.litprotocol.com/core/v1';
const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
const ENCRYPT_GROUP = 'Alexandria encrypt';
const DECRYPT_GROUP = 'Alexandria decrypt';
const POLL_EVERY_MS = 10_000;
const POLL_FOR_MS = 180_000;
const PKP_RE = /^0x[0-9a-fA-F]{40}$/;

const hashCid = (cid) => keccak256(toUtf8Bytes(cid));

const pkpFlag = process.argv.indexOf('--pkp');
const PKP_ARG = pkpFlag > -1 ? process.argv[pkpFlag + 1] : null;
if (pkpFlag > -1 && !PKP_RE.test(PKP_ARG || '')) {
  console.error('--pkp needs a 0x… PKP id.');
  process.exit(1);
}

// ── secrets never printed ───────────────────────────────────────────────────
const secrets = [];
const redact = (s) => secrets.reduce((acc, k) => (k ? acc.split(k).join('<REDACTED>') : acc), String(s));

function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      console.error('No interactive terminal: run this in your own terminal so the key can be typed.');
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

// ── .env ────────────────────────────────────────────────────────────────────
function readEnv(name) {
  if (!fs.existsSync(ENV_FILE)) return '';
  const m = fs.readFileSync(ENV_FILE, 'utf8').match(new RegExp(`^[ \\t]*${name}[ \\t]*=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

/** Replace NAME=… in .env, or append it. Written as soon as a value exists: a usage key is shown once. */
function setEnv(name, value) {
  const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `${name}=${value}`;
  const re = new RegExp(`^[ \\t]*${name}[ \\t]*=.*$`, 'm');
  const next = re.test(text)
    ? text.replace(re, () => line)
    : text + (text === '' || text.endsWith('\n') ? '' : eol) + line + eol;
  const tmp = `${ENV_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    fs.renameSync(tmp, ENV_FILE);
  } catch {
    // OneDrive can hold a lock that blocks the rename; a direct write still lands.
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(ENV_FILE, next);
  }
}

// ── API ─────────────────────────────────────────────────────────────────────
async function api(key, method, endpoint, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Privacy-Mode': 'true' };
  if (key) headers['X-Api-Key'] = key;
  const res = await fetch(URL_ + endpoint, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  // Raw: redacted when printed, so a usage key read from this very response is hidden too.
  return { ok: res.ok, status: res.status, json, text };
}
const runAction = (key, code, js_params) => api(key, 'POST', '/lit_action', { code, js_params });
// Redact before slicing, or a cut could leave part of a key visible.
const log = (label, r, max = 400) => console.log(`  ${label} -> HTTP ${r.status} ${redact(r.text).slice(0, max)}`);
const allowed = (r) => r.ok && !(r.json && r.json.success === false);

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

/** Retry while new permissions take effect (U4), as the docs advise, instead of sleeping a fixed time. */
async function poll(attempt, done) {
  const started = Date.now();
  let last;
  while (Date.now() - started < POLL_FOR_MS) {
    last = await attempt();
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`  +${seconds}s ${last.outcome}`);
    if (done(last)) return { ...last, seconds };
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
  }
  return last;
}

// ── Action code ─────────────────────────────────────────────────────────────
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

// Same code, different bytes, so a CID permitted nowhere.
const UNPERMITTED_CODE = PROBE_CODE + '\n// unpermitted variant';

// ── Run ─────────────────────────────────────────────────────────────────────
const oldKey = readEnv('LIT_API_KEY');
const ACCOUNT_KEY = await promptHidden('NEW Lit account key (hidden): ');
if (!ACCOUNT_KEY) { console.error('No account key.'); process.exit(1); }
if (ACCOUNT_KEY === oldKey) {
  console.error("That is LIT_API_KEY from .env, the OLD account's usage key. Enter the new account's key.");
  process.exit(1);
}
secrets.push(ACCOUNT_KEY);

const before = await api(ACCOUNT_KEY, 'GET', '/billing/balance');
if (!before.ok) { log('billing/balance', before); console.error('Lit refused that key.'); process.exit(1); }
console.log('\nbalance before:', redact(before.text));
// balance_cents is negative while there is credit (measured: -461 = "$4.61 credit").
if (before.json && Number.isInteger(before.json.balance_cents) && before.json.balance_cents >= 0) {
  console.error('This account has no credit. Add some in the dashboard first (the minimum top-up is $5).');
  process.exit(1);
}

const groupList = await api(ACCOUNT_KEY, 'GET', '/list_groups?page_number=0&page_size=100');
log('groups already on the account', groupList, 2000);
const existingGroups = Array.isArray(groupList.json) ? groupList.json : [];

console.log('\nOn the NEW account this will:');
console.log(`  - create groups "${ENCRYPT_GROUP}" and "${DECRYPT_GROUP}" (reused if they exist by name)`);
console.log(PKP_ARG ? `  - use PKP ${PKP_ARG}` : '  - mint a new PKP');
console.log('  - register the encrypt Action in the encrypt group');
console.log('  - create usage keys alex-encrypt and alex-reader, each able to execute in one group only');
console.log("  - write LIT_API_KEY, LIT_READER_API_KEY and LIT_PKP_ID into .env, replacing the old account's");
console.log('  - test it live (~10-30 Lit calls at ~1 cent each), then delete its test action');
if ((await promptLine('Type yes to continue: ')).toLowerCase() !== 'yes') {
  console.log('Cancelled, nothing was changed. Type the whole word "yes" to run.');
  process.exit(0);
}

const results = {};
const state = { encryptGroupId: null, decryptGroupId: null, pkp: PKP_ARG, encryptCid: null };
let probeHash = null;
let probeInGroup = false;
let n4Added = false;
let strayGroupId = null;

async function ensureGroup(name, description) {
  const found = existingGroups.find((g) => g.name === name);
  if (found) {
    const id = Number(BigInt(found.id));
    console.log(`  reusing group "${name}" (id ${id})`);
    return id;
  }
  const g = await api(ACCOUNT_KEY, 'POST', '/add_group', {
    group_name: name,
    group_description: description,
    pkp_ids_permitted: [],
    cid_hashes_permitted: [],
  });
  log(`add_group "${name}"`, g);
  if (!allowed(g)) throw new Error(g.status === 403 ? 'add_group refused: that is not the account key' : 'add_group failed');
  return Number(BigInt(g.json.group_id));
}

async function createKey(name, description, groupId) {
  const r = await api(ACCOUNT_KEY, 'POST', '/add_usage_api_key', {
    name,
    description,
    can_create_groups: false,
    can_delete_groups: false,
    can_create_pkps: false,
    manage_ipfs_ids_in_groups: [],
    add_pkp_to_groups: [],
    remove_pkp_from_groups: [],
    execute_in_groups: [groupId],
  });
  const key = r.json && (r.json.usage_api_key || r.json.api_key);
  if (key) secrets.push(key);
  log(`add_usage_api_key ${name}`, r);
  if (!key) throw new Error(`no usage key returned for ${name}`);
  return key;
}

try {
  console.log('\n1. Groups');
  state.encryptGroupId = await ensureGroup(ENCRYPT_GROUP, 'Uploads: the encrypt Action and our PKP only');
  state.decryptGroupId = await ensureGroup(DECRYPT_GROUP, 'Readers: only the reviewed decryption Action and our PKP');

  console.log('\n2. PKP');
  if (!state.pkp) {
    const w = await api(ACCOUNT_KEY, 'POST', '/create_wallet');
    log('create_wallet', w);
    state.pkp = w.json && w.json.wallet_address;
    if (!PKP_RE.test(state.pkp || '')) throw new Error('create_wallet returned no wallet_address');
  }
  setEnv('LIT_PKP_ID', state.pkp);
  console.log(`  PKP ${state.pkp}, written to .env as LIT_PKP_ID`);
  // Not fatal on their own (a re-run finds the PKP already there); T1 and U2 prove it.
  log('add_pkp_to_group encrypt', await api(ACCOUNT_KEY, 'POST', '/add_pkp_to_group', { group_id: state.encryptGroupId, pkp_id: state.pkp }));
  log('add_pkp_to_group decrypt', await api(ACCOUNT_KEY, 'POST', '/add_pkp_to_group', { group_id: state.decryptGroupId, pkp_id: state.pkp }));

  console.log('\n3. Encrypt Action');
  state.encryptCid = (await api(null, 'POST', '/get_lit_action_ipfs_id', ENCRYPT_CODE)).json;
  if (typeof state.encryptCid !== 'string' || !state.encryptCid) throw new Error('could not derive the encrypt CID');
  console.log('  CID', state.encryptCid);
  log('add_action', await api(ACCOUNT_KEY, 'POST', '/add_action', {
    action_ipfs_cid: state.encryptCid,
    name: 'alexandria-encrypt',
    description: 'Seals an Alexandria book key together with the arweaveHash it unlocks (controller/litProtocol.js).',
  }));
  log('add_action_to_group', await api(ACCOUNT_KEY, 'POST', '/add_action_to_group', { group_id: state.encryptGroupId, action_ipfs_cid: state.encryptCid }));

  console.log('\n4. Usage keys');
  const encryptKey = await createKey('alex-encrypt', 'Backend upload key: seals book keys. Executes in the encrypt group only.', state.encryptGroupId);
  setEnv('LIT_API_KEY', encryptKey);
  const readerKey = await createKey('alex-reader', 'Backend unlock relay: runs the decrypt Action only.', state.decryptGroupId);
  setEnv('LIT_READER_API_KEY', readerKey);
  console.log('  written to .env as LIT_API_KEY and LIT_READER_API_KEY');

  console.log('\n5. Live tests');
  // T1: the real upload path, with the new upload key.
  const envelope = JSON.stringify({ v: 1, k: crypto.randomBytes(32).toString('base64'), arweaveHash: 'setup-probe-not-a-book' });
  const expectedSha256 = '0x' + crypto.createHash('sha256').update(envelope, 'utf8').digest('hex');
  let sealed = null;
  console.log('T1: seal with alex-encrypt');
  const t1 = await poll(async () => {
    const r = await runAction(encryptKey, ENCRYPT_CODE, { pkpId: state.pkp, message: envelope });
    let v = r.ok && !(r.json && r.json.has_error) ? parseResponse(r) : undefined;
    if (v && typeof v === 'object') v = v.ciphertext || v.encryptedSymmetricKey;
    if (typeof v === 'string' && v) sealed = v;
    return { r, outcome: sealed ? 'sealed' : outcome(r) };
  }, () => sealed !== null);
  results.t1_seal = sealed ? `sealed after ${t1.seconds}s` : 'NEVER SEALED';
  if (!sealed) { log('T1 last attempt', t1.r); throw new Error('sealing does not work with the new upload key'); }

  // U2: permit the probe in the decrypt group, for this test only.
  const probeCid = (await api(null, 'POST', '/get_lit_action_ipfs_id', PROBE_CODE)).json;
  probeHash = hashCid(probeCid);
  log('add_action probe', await api(ACCOUNT_KEY, 'POST', '/add_action', {
    action_ipfs_cid: probeCid,
    name: 'alexandria-setup-probe',
    description: 'TEST ONLY, deleted by the script. Returns a hash comparison, never plaintext.',
  }));
  const ag = await api(ACCOUNT_KEY, 'POST', '/add_action_to_group', { group_id: state.decryptGroupId, action_ipfs_cid: probeCid });
  log('add_action_to_group probe', ag);
  probeInGroup = ag.ok;

  console.log('U2: open it in the decrypt group with alex-reader');
  const u2 = await poll(async () => {
    const r = await runAction(readerKey, PROBE_CODE, { pkpId: state.pkp, ciphertext: sealed, expectedSha256 });
    return { r, outcome: outcome(r) };
  }, (x) => x.outcome.startsWith('DECRYPTED'));
  results.u2 = u2.outcome.startsWith('DECRYPTED') ? `${u2.outcome} after ${u2.seconds}s` : 'NEVER DECRYPTED';
  if (!u2.outcome.startsWith('DECRYPTED')) log('U2 last attempt', u2.r);

  // After U2, so the probe's permission has taken effect: a refusal now is the
  // group boundary, not propagation lag. On the old account this decrypted (`Any`).
  const f3 = await runAction(encryptKey, PROBE_CODE, { pkpId: state.pkp, ciphertext: sealed, expectedSha256 });
  results.f3_uploadKeyRunsProbe = outcome(f3);
  log('F3 upload key runs the probe', f3);

  const n1 = await runAction(readerKey, UNPERMITTED_CODE, { pkpId: state.pkp, ciphertext: sealed, expectedSha256 });
  results.n1_readerRunsUnpermittedCode = outcome(n1);
  log('N1 reader runs unpermitted code', n1);

  const n2 = await runAction(readerKey, ENCRYPT_CODE, { pkpId: state.pkp, message: 'n2' });
  results.n2_readerRunsEncryptAction = outcome(n2);
  log('N2 reader runs the encrypt Action', n2);

  const n3 = await api(readerKey, 'POST', '/add_group', { group_name: 'should-fail', group_description: '', pkp_ids_permitted: [], cid_hashes_permitted: [] });
  results.n3_readerCreatesGroup = allowed(n3) ? 'ALLOWED' : 'refused';
  if (allowed(n3) && n3.json && n3.json.group_id) strayGroupId = Number(BigInt(n3.json.group_id));
  log('N3 reader creates a group', n3);

  const n4 = await api(encryptKey, 'POST', '/add_action_to_group', { group_id: state.decryptGroupId, action_ipfs_cid: state.encryptCid });
  results.n4_uploadKeyEditsDecryptGroup = allowed(n4) ? 'ALLOWED' : 'refused';
  n4Added = allowed(n4);
  log('N4 upload key edits the decrypt group', n4);
} catch (err) {
  console.error('\nSTOPPED:', redact(err.message));
  process.exitCode = 1;
} finally {
  console.log('\nCleanup');
  if (probeHash && probeInGroup) log('remove_action_from_group probe', await api(ACCOUNT_KEY, 'POST', '/remove_action_from_group', { group_id: state.decryptGroupId, hashed_cid: probeHash }));
  if (probeHash) log('delete_action probe', await api(ACCOUNT_KEY, 'POST', '/delete_action', { hashed_cid: probeHash }));
  if (n4Added) log('remove_action_from_group (N4)', await api(ACCOUNT_KEY, 'POST', '/remove_action_from_group', { group_id: state.decryptGroupId, hashed_cid: hashCid(state.encryptCid) }));
  if (strayGroupId !== null) log('remove_group (N3)', await api(ACCOUNT_KEY, 'POST', '/remove_group', { group_id: String(strayGroupId) }));

  // KEY-BINDING.md: enumerate after every change. A stray permissive entry defeats every check.
  console.log('\nState after: encrypt group = our PKP + the encrypt Action; decrypt group = our PKP only (for now)');
  for (const [name, id] of [[ENCRYPT_GROUP, state.encryptGroupId], [DECRYPT_GROUP, state.decryptGroupId]]) {
    if (id === null) continue;
    const actions = await api(ACCOUNT_KEY, 'GET', `/list_actions?group_id=${id}&page_number=0&page_size=100`);
    const wallets = await api(ACCOUNT_KEY, 'GET', `/list_wallets_in_group?group_id=${id}&page_number=0&page_size=100`);
    log(`actions in "${name}" (${id})`, actions, 2000);
    log(`wallets in "${name}" (${id})`, wallets, 2000);
    if (/"Any"/.test(actions.text)) console.log(`  ⚠️  "${name}" permits the action "Any": remove it`);
    if (/0x0{40}/i.test(wallets.text)) console.log(`  ⚠️  "${name}" holds the 0x000… wallet: remove it`);
  }
  const keys = await api(ACCOUNT_KEY, 'GET', '/list_api_keys?page_number=0&page_size=100');
  console.log('  usage keys:', Array.isArray(keys.json) ? keys.json.map((x) => x.name).join(', ') : redact(keys.text));
  console.log('balance after:', redact((await api(ACCOUNT_KEY, 'GET', '/billing/balance')).text));

  console.log('\nRESULT', JSON.stringify({ ...state, ...results }, null, 2));
  console.log('Expected: t1 sealed, u2 "DECRYPTED, matches", f3/n1/n2 refused, n3/n4 refused.');
  if (state.pkp && state.decryptGroupId !== null) {
    console.log('\nNext:');
    console.log(`  1. Frontend src/services/litAction.js: set LIT_PKP_ID = '${state.pkp}'`);
    console.log('  2. Frontend folder: npm run lit:register   (dry run, prints the decrypt Action CID)');
    console.log(`  3. Frontend folder: $env:LIT_GROUP_ID=${state.decryptGroupId}; npm run lit:register -- --register   (account key at the prompt)`);
    console.log('  4. Backend .env: LIT_DECRYPT_ACTION_CID=<that CID>, then restart the backend');
  }
}
