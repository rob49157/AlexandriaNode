// Lit Protocol Chipotle v3 REST API client.
//
// Replaces the old LitNodeClientNodeJs SDK singleton (Datil, shut down Feb 2026).
// Chipotle is REST-first: no persistent connection, no heavy SDK, just HTTP calls
// authenticated with an API key from dashboard.chipotle.litprotocol.com.
//
// The backend only needs encryption (never decryption). Encryption is done by
// executing a Lit Action (JS in a TEE) via POST /lit_action that calls
// Lit.Actions.Encrypt with our PKP.

const LIT_API_URL = process.env.LIT_API_URL || 'https://api.chipotle.litprotocol.com/core/v1';
const LIT_API_KEY = process.env.LIT_API_KEY || '';
const LIT_PKP_ID = process.env.LIT_PKP_ID || '';

/**
 * Make an authenticated call to the Lit Chipotle REST API.
 *
 * @param {string} endpoint  — API path (e.g. '/lit_action', '/version')
 * @param {object} [body]    — JSON request body (omit for GET-like semantics)
 * @returns {Promise<object>} — parsed JSON response
 */
async function litApiCall(endpoint, body) {
  if (!LIT_API_KEY) {
    throw new Error(
      'LIT_API_KEY is not set. Create an account at dashboard.chipotle.litprotocol.com and add the key to .env.'
    );
  }

  const url = `${LIT_API_URL}${endpoint}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': LIT_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`Lit API ${endpoint} responded ${res.status}: ${text}`);
  }

  return res.json();
}

// No-op for backward compatibility — REST is stateless, nothing to disconnect.
async function disconnectLit() {}

module.exports = { litApiCall, disconnectLit, LIT_API_URL, LIT_API_KEY, LIT_PKP_ID };
