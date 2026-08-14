// Demonstration: why the symmetric key must be sealed together with its
// arweaveHash, and what breaks if the decryption Lit Action trusts a parameter.
//
// Run: node tests/keyBinding.demo.js
//
// Nothing here touches the network. It simulates three things in-process:
//   • Rent.sol       — the on-chain rental check
//   • Arweave        — a bucket of encrypted blobs
//   • The Lit TEE    — the only thing that can unwrap a PKP-sealed payload
//
// The AES-256-GCM encryption is REAL. When the attack succeeds below, the
// attacker genuinely recovers the plaintext bytes of a book they never rented.

const crypto = require('crypto');

const line = (c = '─') => console.log(c.repeat(74));

// ─────────────────────────────────────────────────────────────────────────────
// The world
// ─────────────────────────────────────────────────────────────────────────────

const ALICE = '0xa11ce0000000000000000000000000000000a11ce';

// On-chain state. Alice rented the cheap pamphlet. She did NOT rent the rare one.
const RENTALS = {
  'hash_CHEAP_PAMPHLET_0000000000000000000000': [ALICE],
  'hash_RARE_FIRST_EDITION_00000000000000000': [], // nobody
};

// Stands in for Rent.sol.isRentalActive(arweaveHash, renter)
function isRentalActive(arweaveHash, user) {
  return (RENTALS[arweaveHash] || []).includes(user);
}

// Stands in for Arweave: arweaveHash → encrypted bytes. Public — anyone can
// fetch any blob. Storage is not the access control; the key is.
const ARWEAVE = {};

// ─── The Lit TEE ────────────────────────────────────────────────────────────
// The PKP's unwrapping power lives inside the enclave. A Lit Action running in
// the TEE can call this; nothing outside can. We fake it with a fixed key.
const PKP_INTERNAL_KEY = crypto.randomBytes(32);

function pkpSeal(plaintextString) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', PKP_INTERNAL_KEY, iv);
  const body = Buffer.concat([cipher.update(plaintextString, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function pkpUnseal(sealedBase64) {
  const raw = Buffer.from(sealedBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', PKP_INTERNAL_KEY, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload: encrypt a book two ways — unbound (old) and bound (current)
// ─────────────────────────────────────────────────────────────────────────────

function publish(arweaveHash, pdfText) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(pdfText, 'utf8'), cipher.final()]);

  ARWEAVE[arweaveHash] = { ciphertext, iv, authTag: cipher.getAuthTag() };

  return {
    // OLD: just the key. The sealed blob says nothing about which book it opens.
    unboundKey: pkpSeal(key.toString('base64')),
    // CURRENT: the key travels with the hash of the object it unlocks.
    boundKey: pkpSeal(JSON.stringify({ v: 1, k: key.toString('base64'), arweaveHash })),
  };
}

// Use the recovered key against a blob fetched from Arweave.
function readBook(arweaveHash, keyBase64) {
  const { ciphertext, iv, authTag } = ARWEAVE[arweaveHash];
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Two Lit Actions. This is the whole lesson — the difference is 2 lines.
// ─────────────────────────────────────────────────────────────────────────────

// ✗ NAIVE: gates on the arweaveHash the CALLER supplied.
function naiveDecryptAction({ sealedKey, arweaveHash, user }) {
  if (!isRentalActive(arweaveHash, user)) {
    return { denied: true };
  }
  // Gate passed — unseal whatever blob was handed in. The TEE has no idea
  // whether this key belongs to the book that was just checked.
  return { key: pkpUnseal(sealedKey) };
}

// ✓ CORRECT: gates on the arweaveHash sealed INSIDE the ciphertext.
function boundDecryptAction({ sealedKey, arweaveHash: claimedHash, user }) {
  const envelope = JSON.parse(pkpUnseal(sealedKey));

  // The caller's claim is ignored entirely. The only hash that counts is the
  // one the backend sealed at upload time, which the caller cannot forge.
  if (!isRentalActive(envelope.arweaveHash, user)) {
    return { denied: true, claimedHash, actualHash: envelope.arweaveHash };
  }
  return { key: envelope.k };
}

// ─────────────────────────────────────────────────────────────────────────────

const CHEAP = 'hash_CHEAP_PAMPHLET_0000000000000000000000';
const RARE = 'hash_RARE_FIRST_EDITION_00000000000000000';

const cheapKeys = publish(CHEAP, 'A 12-page pamphlet on beekeeping. Rents for 1 ALEX.');
const rareKeys = publish(RARE, 'RARE: Newton, Principia Mathematica, 1687 first edition.');

console.log('\nSetup');
line();
console.log(`Alice: ${ALICE.slice(0, 10)}…`);
console.log(`  rented  ${CHEAP}  →  ${isRentalActive(CHEAP, ALICE)}`);
console.log(`  rented  ${RARE}   →  ${isRentalActive(RARE, ALICE)}`);
console.log('\nBoth encrypted blobs sit on Arweave. Anyone can download either one —');
console.log('storage is public. The rental gate is the only thing protecting the rare book.');

// ── 1. Legitimate use, naive action ──────────────────────────────────────────
console.log('\n\n1. Alice reads the pamphlet she actually rented (naive Action)');
line();
const legit = naiveDecryptAction({ sealedKey: cheapKeys.unboundKey, arweaveHash: CHEAP, user: ALICE });
console.log(`  isRentalActive(CHEAP, alice) → true, so the TEE releases the key`);
console.log(`  She reads: "${readBook(CHEAP, legit.key)}"`);
console.log('  ✓ Correct. This is what the flow is supposed to do.');

// ── 2. The attack ────────────────────────────────────────────────────────────
console.log('\n\n2. THE ATTACK — Alice steals the rare book (naive Action)');
line();
console.log('  She downloads the RARE blob and its sealed key from Arweave (both public),');
console.log('  then calls the Action with a deliberate mismatch:');
console.log('');
console.log('      sealedKey   = <RARE\'s sealed key>      ← the book she wants');
console.log('      arweaveHash = CHEAP                     ← the book she rented');
console.log('');

const stolen = naiveDecryptAction({
  sealedKey: rareKeys.unboundKey, // RARE's key
  arweaveHash: CHEAP, // CHEAP's hash
  user: ALICE,
});

if (stolen.denied) {
  console.log('  Denied.');
} else {
  console.log('  The gate checks isRentalActive(CHEAP, alice) → true. It passes.');
  console.log('  The TEE then unseals the key it was given — RARE\'s key.');
  console.log('');
  console.log(`  >>> Alice reads: "${readBook(RARE, stolen.key)}"`);
  console.log('');
  console.log('  ✗ STOLEN. She never rented this book. She paid for a 1 ALEX pamphlet.');
  console.log('    The check ran, returned true, and protected nothing — it verified a');
  console.log('    fact about a completely different book.');
}

// ── 3. Same attack, bound envelope ───────────────────────────────────────────
console.log('\n\n3. The identical attack against the bound Action');
line();
const blocked = boundDecryptAction({
  sealedKey: rareKeys.boundKey,
  arweaveHash: CHEAP, // same lie
  user: ALICE,
});

if (blocked.denied) {
  console.log(`  She claims:  ${blocked.claimedHash}`);
  console.log(`  Envelope says: ${blocked.actualHash}   ← sealed at upload, unforgeable`);
  console.log('');
  console.log('  The Action never reads her claim. It unseals first, takes the hash from');
  console.log('  inside the ciphertext, and checks isRentalActive(RARE, alice) → false.');
  console.log('');
  console.log('  ✓ DENIED. To forge the envelope she would need the PKP, which lives in');
  console.log('    the TEE. The lie is not expressible.');
} else {
  console.log('  ✗ Attack succeeded — the binding is not working.');
}

// ── 4. Legitimate use still works ────────────────────────────────────────────
console.log('\n\n4. Sanity check — the bound Action is not just refusing everything');
line();
const stillWorks = boundDecryptAction({ sealedKey: cheapKeys.boundKey, arweaveHash: CHEAP, user: ALICE });
console.log(`  Alice reads her pamphlet: "${readBook(CHEAP, stillWorks.key)}"`);
console.log('  ✓ Legitimate access is unaffected.');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n');
line('═');
console.log('THE DIFFERENCE');
line('═');
console.log(`
  ✗  const hash = jsParams.arweaveHash;          // caller says which book
     if (!isRentalActive(hash, user)) return;
     return pkpUnseal(jsParams.sealedKey);

  ✓  const env = JSON.parse(pkpUnseal(jsParams.sealedKey));
     if (!isRentalActive(env.arweaveHash, user)) return;   // ciphertext says
     return env.k;

  Both compile. Both pass a demo where the caller is honest. Only one survives
  a caller who is not — which is why this cannot be caught by testing the happy
  path, and why it has to be stated as a requirement to whoever writes the
  Action rather than discovered later.
`);
line('═');
console.log('');
