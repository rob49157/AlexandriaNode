# Key Binding — the rental-gate bypass, and how it's prevented

> **The requirement, in one sentence:**
> The decryption Lit Action **MUST** read `arweaveHash` out of the decrypted envelope and gate on *that* value. It must **never** gate on an `arweaveHash` passed in as a `js_param`.

Anyone writing or reviewing the decryption Lit Action needs to read this. The vulnerability it describes cannot be caught by testing the happy path, and the broken version looks completely reasonable.

---

## Status

| Half | State |
|---|---|
| **Encrypt** — seal the hash into the key envelope | ✅ Done (`controller/litProtocol.js`). Since 2026-10-13 the hash is a direct Arweave L1 transaction id (see "Where the hash comes from"). |
| **Decrypt** — gate on the sealed hash | ✅ Built in the frontend: `AlexandriaFrontEnd/Alexandria-Front-end/src/services/litAction.js`, tested by `npm run test:lit-action` (23 tests, including the negative test, #7). Reviewed against the checklist below on 2026-10-13. One item is still open: the permitted-CID audit on the live Lit account. |

The decrypt half is where this can still go wrong. Every edit to the Action changes its IPFS CID and must re-pass the checklist and the negative test before `npm run lit:register`.

**Live state (2026-10-13):** books are now stored on Arweave **mainnet**. Two live test books exist (`lNpEgp90…PRc` and `0Nefi7ad…MCA`, both encrypted test PDFs). Their sealed envelopes are only as safe as the Action that is permitted against the PKP.

---

## Background — how a book gets encrypted

Alexandria uses **two-layer envelope encryption** (see `CLAUDE.md`):

1. **Layer 1 (local, backend):** a random AES-256 key encrypts the PDF. The ciphertext goes to Arweave.
2. **Layer 2 (Lit TEE):** that 32-byte key is sealed by a PKP inside a Trusted Execution Environment.

Access control is **not** applied at encryption time. It is enforced at *decryption* time by a Lit Action — immutable JavaScript, pinned to IPFS, running inside the TEE. The backend is deliberately never in the decryption path.

So the entire security model rests on one function:

```
Lit Action:  "should this user get this key?"  →  Rent.sol.isRentalActive(arweaveHash, user)
```

Two facts make the details matter enormously:

- **Arweave is public storage.** Anyone can download any encrypted blob. Encryption, not storage, is the access control.
- **The sealed key is also public.** It lives in the Postgres index (`litEncryptedKeyId`) and is served to clients. It is useless without the TEE — which is exactly why the TEE's decision is the whole game.

---

## The vulnerability

This is a **confused deputy**: a privileged component (the TEE) performs an authorization check on one object, then acts on a *different* object, because the caller supplied the two independently.

The naive Action takes both the sealed key and the hash as parameters:

```js
// ✗ VULNERABLE
async function main({ sealedKey, arweaveHash, user }) {
  if (!(await isRentalActive(arweaveHash, user))) return;   // checks what the CALLER named
  return decrypt(sealedKey);                                // acts on what the CALLER handed over
}
```

Nothing ties those two arguments together. The attack is to make them disagree:

```
sealedKey   = <expensive book's sealed key>   ← the object acted upon
arweaveHash = <cheap book I actually rented>  ← the object checked
```

The gate runs. It returns `true`. It is not lying — the user really did rent the cheap book. It simply answered a question about a completely different book than the one whose key it then released.

**Cost to the attacker:** one legitimate rental of the cheapest item in the library. From there, every book is readable.

### Why the old design was exposed to this

Before Phase 5, the sealed payload was just the base64 key:

```js
message: symmetricKey.toString('base64')     // says nothing about which book
```

An unwrapped key carried no evidence of what it was for, so the TEE had no way to cross-check the caller's claim even if it wanted to. The hash *had* to come from the caller, and a caller-supplied authorization subject is not an authorization subject.

---

## Working example

A runnable demonstration lives at **`tests/keyBinding.demo.js`**:

```bash
node tests/keyBinding.demo.js
```

It simulates `Rent.sol`, Arweave, and the Lit TEE in-process. **The AES-256-GCM is real** — when the attack succeeds, the attacker genuinely recovers plaintext bytes of a book they never rented.

Setup: Alice rents a 1 ALEX pamphlet. She does not rent a Newton first edition. Both encrypted blobs are publicly downloadable.

### The attack (abridged output)

```
2. THE ATTACK — Alice steals the rare book (naive Action)
──────────────────────────────────────────────────────────
  She downloads the RARE blob and its sealed key from Arweave (both public),
  then calls the Action with a deliberate mismatch:

      sealedKey   = <RARE's sealed key>      ← the book she wants
      arweaveHash = CHEAP                     ← the book she rented

  The gate checks isRentalActive(CHEAP, alice) → true. It passes.
  The TEE then unseals the key it was given — RARE's key.

  >>> Alice reads: "RARE: Newton, Principia Mathematica, 1687 first edition."

  ✗ STOLEN. She never rented this book. She paid for a 1 ALEX pamphlet.
```

### The same attack against the bound envelope

```
3. The identical attack against the bound Action
──────────────────────────────────────────────────────────
  She claims:    hash_CHEAP_PAMPHLET_...
  Envelope says: hash_RARE_FIRST_EDITION_...   ← sealed at upload, unforgeable

  The Action never reads her claim. It unseals first, takes the hash from
  inside the ciphertext, and checks isRentalActive(RARE, alice) → false.

  ✓ DENIED. To forge the envelope she would need the PKP, which lives in
    the TEE. The lie is not expressible.
```

---

## Why this is so easy to miss

Run step 1 of the demo — the honest happy path — against both Actions. They behave **identically**. Alice rents a book, asks for it, gets it.

A test suite written by someone who hasn't considered this will be entirely green on the vulnerable version. The bug only appears when the caller is *deliberately inconsistent*, and "pass two arguments that disagree" is not a case that naturally occurs to someone testing their own feature.

It also reads as correct. `if (!isRentalActive(hash, user)) return;` is exactly the line you'd expect to see. The defect is not in the line — it's in where `hash` came from, three lines earlier.

---

## The mitigation

### 1. Seal the hash with the key (✅ implemented)

`controller/litProtocol.js` seals a versioned envelope instead of a bare key:

```js
function buildKeyEnvelope(symmetricKey, arweaveHash) {
  return JSON.stringify({
    v: 1,
    k: symmetricKey.toString('base64'),
    arweaveHash,
  });
}
```

`sealKey(symmetricKey, arweaveHash)` requires the hash — there is no default. An optional binding would be no binding at all.

**Where the hash comes from before upload:** an Arweave L1 transaction id is `base64url(sha256(signature))`, 43 characters, so it is fully determined the moment the transaction is signed. The signature covers `data_root`, the Merkle root of the encrypted bytes. The pipeline signs locally (free, offline), reads the id, seals the envelope against it, and only *then* posts the header. `prepareUpload` in `controller/arweave.js` recomputes the id from the signature on every upload and refuses to continue if they differ. The same was checked live on mainnet (ARWEAVE-DIRECT-PLAN.md §9 Q1): the id is base64url(sha256(signature)), and nodes report the same id.

**A transaction that is never mined cannot be re-sealed.** A header stays valid for 50 blocks after its anchor block. If it is not mined by then, the only way to store the book is to sign again, which gives a **new id**. The envelope is bound to the old one, and the symmetric key was zeroed right after sealing, so the key cannot be sealed again to the new id. That is deliberate: keeping the key around to allow re-sealing would break the rule that keys never outlive the request. Instead the upload ends as `storage_failed` and the archivist uploads the file again, getting a new key, a new id and a new envelope (decision D1). Re-posting the **same** signed header while it is still valid keeps the same id, so the storage worker does that first, and the binding is untouched.

### 2. Gate on the sealed hash (✅ built in the frontend: `src/services/litAction.js`)

The shape below is the requirement. The real Action follows it: `main({ pkpId, ciphertext, userAddress })`, with no hash parameter. It calls `Lit.Actions.Decrypt` first, rejects any envelope that is not `v === 1` with `k` and `arweaveHash`, and only then checks `isRentalActive(envelope.arweaveHash, userAddress)` (plus the uploader and librarian-review carve-outs).

```js
// ✓ CORRECT
async function main({ sealedKey, user }) {
  const envelope = JSON.parse(await unseal(sealedKey));

  // The only hash that counts is the one sealed at upload time.
  // Any hash the caller supplies is ignored entirely.
  if (envelope.v !== 1) return;                                   // reject unknown formats
  if (!(await isRentalActive(envelope.arweaveHash, user))) return; // fail closed
  return envelope.k;
}
```

Three properties to preserve:

- **Unseal before you check.** The hash cannot be trusted until it comes out of the ciphertext.
- **Never accept an `arweaveHash` parameter at all.** If the signature doesn't have one, it can't be misused. Don't accept it "for logging".
- **Fail closed.** Any unexpected state — bad JSON, unknown `v`, missing field, RPC error reading `Rent.sol` — returns nothing. Never fall through to releasing the key.

> ⚠️ **API caveat:** sealing uses `Lit.Actions.Encrypt({ pkpId, message })` (confirmed working: `scripts/lit-setup.js`, `tests/encryption.manual.js`). The frontend Action unseals with `Lit.Actions.Decrypt({ pkpId, ciphertext })`. Its tests run against a simulated TEE; this review did **not** run a decrypt against live Lit. **The structure above is API-independent** — unseal, read the hash from inside, gate on it — and that structure is the requirement, whatever the call is named.

### 3. Defense in depth

- **Pin the Action, permit only that CID.** Chipotle derives an IPFS CID from the Action source and permits it against the PKP (`scripts/lit-setup.js`). Only the reviewed decryption Action's CID should ever be permitted to unwrap keys. This is what stops an attacker from simply supplying their *own* Action that skips the check — and it means the code is immutable once pinned, so review happens before registration, not after.
- **Audit the permitted-action list.** Register the decryption Action deliberately and enumerate the group's actions afterwards. A stray permissive Action left over from testing defeats everything above.
- **Include `v` in the envelope and check it.** Lets a future format change be rejected rather than misparsed.
- **Keep the backend out of the decryption path.** It has no wallet and no authority here; adding a backend-side "convenience" decrypt endpoint would recreate a central bypass of the whole model.

### Rejected alternatives

| Approach | Why not |
|---|---|
| Store the key→hash mapping in Postgres; have the Action look it up | Makes the backend a trusted authority, defeating the point of on-chain-enforced access. A compromised or offline index becomes a compromised or offline library. |
| Bind `arweaveHash` as AES-GCM **AAD** on the PDF ciphertext | **Circular.** The Arweave id is sha256 of a signature over `data_root`, which is computed from the ciphertext. The hash cannot be an input to the thing it's computed from. (Binding `sha256Hash` as AAD is non-circular but doesn't help the rental gate.) |
| Check the rental in the frontend before requesting the key | The frontend is not a trust boundary. An attacker calls the Lit Action directly. |
| Return the key only over an authenticated backend session | Same problem — the TEE is reachable without the backend, by design. |

---

## Reviewer checklist for the decryption Lit Action

Checked against `src/services/litAction.js` and `tests/decryptionAction.test.js` on 2026-10-13. Re-check after every edit to the Action.

- [x] The Action's parameters do **not** include `arweaveHash` (or any alias — `hash`, `txId`, `bookId`). *Signature is `main({ pkpId, ciphertext, userAddress })`.*
- [x] The sealed payload is unwrapped **before** any authorization check runs. *`Lit.Actions.Decrypt` is the first call.*
- [x] `isRentalActive` is called with the hash read from the decrypted envelope, and nothing else.
- [x] Envelope `v` is checked; unknown versions are rejected. *`envelope.v !== 1` → `invalid_envelope_format`.*
- [x] Every failure path returns without releasing the key — no `catch` that falls through. *Unseal and envelope errors return `{ error }` immediately. A failed contract read (rental, uploader, librarian state) sets that check to `false`, so the gate denies. The key is only released after the gate passes. Test 9: a paused Rent contract denies.*
- [x] A negative test exists: sealed key for book A + claimed hash for book B ⇒ **denied**. *Test 7, "renting book A does not unlock book B". The Action has no hash parameter, so the claim cannot even be expressed.*
- [ ] Only the reviewed Action's IPFS CID is permitted against the PKP; the permitted list has been enumerated and has no leftovers. *Not verified: needs the live Lit account (`npm run lit:register` output plus a listing of the group's actions).*

The negative test is the one that matters. Everything else can pass while the system is fully exploitable.

---

## References

- `tests/keyBinding.demo.js` — runnable exploit + fix
- `controller/litProtocol.js` — `buildKeyEnvelope`, `sealKey`
- `controller/arweave.js` — `prepareUpload`: how `arweaveHash` is known (and checked) before upload
- `controller/upload.controller.js` — pipeline ordering (sign → seal → spool → persist → post header)
- `services/storage.service.js` — re-posting the same header; `storage_failed` when it can never be mined
- `ARWEAVE-DIRECT-PLAN.md` — D1 (drops), §9 Q1 (id verified live)
- `AlexandriaFrontEnd/Alexandria-Front-end/src/services/litAction.js` — the decryption Action
- `AlexandriaFrontEnd/Alexandria-Front-end/tests/decryptionAction.test.js` — its tests, incl. the negative test
- `CHECKLIST.md` — Phase 5, "Carry-over: the binding is only half-built"
- `CLAUDE.md` — "The sealed payload is an envelope, not a bare key"
