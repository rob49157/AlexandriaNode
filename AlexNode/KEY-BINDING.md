# Key Binding — the rental-gate bypass, and how it's prevented

> **The requirement, in one sentence:**
> The decryption Lit Action **MUST** read `arweaveHash` out of the decrypted envelope and gate on *that* value. It must **never** gate on an `arweaveHash` passed in as a `js_param`.

Anyone writing or reviewing the decryption Lit Action needs to read this. The vulnerability it describes cannot be caught by testing the happy path, and the broken version looks completely reasonable.

---

## Status

| Half | State |
|---|---|
| **Encrypt** — seal the hash into the key envelope | ✅ Done (Phase 5, `controller/litProtocol.js`) |
| **Decrypt** — gate on the sealed hash | ⬜ Not built. Frontend / Phase 5+. **This is the half that can still get it wrong.** |

Phase 5 makes the correct implementation *possible* — the hash is sitting inside the envelope waiting to be read. It does not make it *inevitable*. If the Action is written the naive way, everything in Phase 5 is decorative and the exploit below is production behaviour.

Nothing is currently at risk: the `Upload` table is empty, nothing has been pushed to Arweave, and no decryption path exists yet.

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

**Where the hash comes from before upload:** an Irys data item's ID is `sha256(signature)`, so it is fully determined the moment the item is signed. The pipeline signs locally (free, offline), reads the ID, seals the envelope against it, and only *then* pushes the bytes. No placeholder or reserved-txid dance. See `controller/arweave.js`.

### 2. Gate on the sealed hash (⬜ to build)

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

> ⚠️ **API caveat:** the exact Chipotle v3 decrypt call is **not yet verified**. We use `Lit.Actions.Encrypt({ pkpId, message })` for sealing (confirmed working — `scripts/lit-setup.js`, `tests/encryption.manual.js`), but the decrypt counterpart has not been exercised. Confirm the real signature against Lit's docs. **The structure above is API-independent** — unseal, read the hash from inside, gate on it — and that structure is the requirement, whatever the call is named.

### 3. Defense in depth

- **Pin the Action, permit only that CID.** Chipotle derives an IPFS CID from the Action source and permits it against the PKP (`scripts/lit-setup.js`). Only the reviewed decryption Action's CID should ever be permitted to unwrap keys. This is what stops an attacker from simply supplying their *own* Action that skips the check — and it means the code is immutable once pinned, so review happens before registration, not after.
- **Audit the permitted-action list.** Register the decryption Action deliberately and enumerate the group's actions afterwards. A stray permissive Action left over from testing defeats everything above.
- **Include `v` in the envelope and check it.** Lets a future format change be rejected rather than misparsed.
- **Keep the backend out of the decryption path.** It has no wallet and no authority here; adding a backend-side "convenience" decrypt endpoint would recreate a central bypass of the whole model.

### Rejected alternatives

| Approach | Why not |
|---|---|
| Store the key→hash mapping in Postgres; have the Action look it up | Makes the backend a trusted authority, defeating the point of on-chain-enforced access. A compromised or offline index becomes a compromised or offline library. |
| Bind `arweaveHash` as AES-GCM **AAD** on the PDF ciphertext | **Circular.** The Arweave ID is derived from the signed data item, which contains the ciphertext — the hash cannot be an input to the thing it's computed from. (Binding `sha256Hash` as AAD is non-circular but doesn't help the rental gate.) |
| Check the rental in the frontend before requesting the key | The frontend is not a trust boundary. An attacker calls the Lit Action directly. |
| Return the key only over an authenticated backend session | Same problem — the TEE is reachable without the backend, by design. |

---

## Reviewer checklist for the decryption Lit Action

- [ ] The Action's parameters do **not** include `arweaveHash` (or any alias — `hash`, `txId`, `bookId`).
- [ ] The sealed payload is unwrapped **before** any authorization check runs.
- [ ] `isRentalActive` is called with the hash read from the decrypted envelope, and nothing else.
- [ ] Envelope `v` is checked; unknown versions are rejected.
- [ ] Every failure path returns without releasing the key — no `catch` that falls through.
- [ ] A negative test exists: sealed key for book A + claimed hash for book B ⇒ **denied**.
- [ ] Only the reviewed Action's IPFS CID is permitted against the PKP; the permitted list has been enumerated and has no leftovers.

The negative test is the one that matters. Everything else can pass while the system is fully exploitable.

---

## References

- `tests/keyBinding.demo.js` — runnable exploit + fix
- `controller/litProtocol.js` — `buildKeyEnvelope`, `sealKey`
- `controller/arweave.js` — how `arweaveHash` is known before upload
- `controller/upload.controller.js` — pipeline ordering
- `CHECKLIST.md` — Phase 5, "Carry-over: the binding is only half-built"
- `CLAUDE.md` — "The sealed payload is an envelope, not a bare key"
