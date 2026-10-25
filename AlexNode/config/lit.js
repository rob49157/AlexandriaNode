// Lit Protocol Chipotle v3 REST API client.
//
// Replaces the old LitNodeClientNodeJs SDK singleton (Datil, shut down Feb 2026).
// Chipotle is REST-first: no persistent connection, no heavy SDK, just HTTP calls
// authenticated with an API key from dashboard.chipotle.litprotocol.com.
//
// Two keys, never merged (KEY-BINDING.md, steps C/D and R4):
//   LIT_API_KEY         seals keys at upload (Lit.Actions.Encrypt, group 1)
//   LIT_READER_API_KEY  relays reader unlocks (POST /api/rental/unlock). It can run
//                       only the reviewed decryption Action, in the decrypt group,
//                       and the Action answers with a key wrapped to the reader's
//                       browser — so the backend never holds a usable book key.

const LIT_API_URL = process.env.LIT_API_URL || 'https://api.chipotle.litprotocol.com/core/v1';
const LIT_API_KEY = process.env.LIT_API_KEY || '';
const LIT_READER_API_KEY = process.env.LIT_READER_API_KEY || '';
const LIT_PKP_ID = process.env.LIT_PKP_ID || '';

/**
 * Make an authenticated call to the Lit Chipotle REST API.
 *
 * @param {string} endpoint  — API path (e.g. '/lit_action', '/version')
 * @param {object} [body]    — JSON request body (omit for GET-like semantics)
 * @param {object} [options]
 * @param {string} [options.apiKey]   — defaults to LIT_API_KEY (the upload key)
 * @param {boolean} [options.privacy] — send X-Privacy-Mode, so Lit does not write
 *                                      js_params or the action's output to its logs
 * @returns {Promise<object>} — parsed JSON response
 */
async function litApiCall(endpoint, body, { apiKey = LIT_API_KEY, privacy = false } = {}) {
  if (!apiKey) {
    throw new Error(
      'LIT_API_KEY is not set. Create an account at dashboard.chipotle.litprotocol.com and add the key to .env.'
    );
  }

  const url = `${LIT_API_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
  };
  if (privacy) headers['X-Privacy-Mode'] = 'true';

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    const err = new Error(`Lit API ${endpoint} responded ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

/**
 * The IPFS CID Lit derives from a Lit Action's source — the identity its groups
 * permit. Free and unauthenticated.
 *
 * @param {string} code
 * @returns {Promise<string>}
 */
async function getLitActionCid(code) {
  const res = await fetch(`${LIT_API_URL}/get_lit_action_ipfs_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(code),
  });
  if (!res.ok) {
    const err = new Error(`Lit API /get_lit_action_ipfs_id responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const cid = await res.json();
  if (typeof cid !== 'string' || !cid) throw new Error('Lit returned no CID');
  return cid;
}

/**
 * Credit left on the Lit account, in cents. Both keys bill the same account.
 *
 * GET /billing/balance is undocumented beyond "credit balance". Measured
 * 2026-10-17: it answers {"balance_cents":-461,"balance_display":"$4.61 credit"},
 * and spending moved balance_cents from -470 towards zero, so credit is
 * -balance_cents. Any other shape throws, and the caller decides what that means.
 *
 * @param {string} [apiKey] defaults to LIT_READER_API_KEY
 * @returns {Promise<number>}
 */
async function getLitCreditCents(apiKey = LIT_READER_API_KEY) {
  const res = await fetch(`${LIT_API_URL}/billing/balance`, { headers: { 'X-Api-Key': apiKey } });
  if (!res.ok) {
    const err = new Error(`Lit API /billing/balance responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  if (!body || !Number.isInteger(body.balance_cents)) throw new Error('Lit returned no balance_cents');
  return -body.balance_cents;
}

// No-op for backward compatibility — REST is stateless, nothing to disconnect.
async function disconnectLit() {}

module.exports = {
  litApiCall,
  getLitActionCid,
  getLitCreditCents,
  disconnectLit,
  LIT_API_URL,
  LIT_API_KEY,
  LIT_READER_API_KEY,
  LIT_PKP_ID,
};
