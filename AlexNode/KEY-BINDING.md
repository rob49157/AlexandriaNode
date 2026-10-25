# Key Binding — the rental-gate bypass, and how it's prevented

> **The requirement, in one sentence:**
> The decryption Lit Action **MUST** read `arweaveHash` out of the decrypted envelope and gate on *that* value. It must **never** gate on an `arweaveHash` passed in as a `js_param`.

Anyone writing or reviewing the decryption Lit Action needs to read this. The vulnerability it describes cannot be caught by testing the happy path, and the broken version looks completely reasonable.

---

## Status

| Half | State |
|---|---|
| **Encrypt** — seal the hash into the key envelope | ✅ Done (`controller/litProtocol.js`). Since 2026-10-13 the hash is a direct Arweave L1 transaction id (see "Where the hash comes from"). |
| **Decrypt** — gate on the sealed hash | ✅ Built in the frontend: `AlexandriaFrontEnd/Alexandria-Front-end/src/services/litAction.js`. **Rebuilt 2026-10-17** to the reviewed design: signed identity, session-bound release, two RPC providers, and (same day) an uploader door that needs the uploader's own stake. CID `QmQ7zqvwrHMhnKFTcmWRQuLhNR4wnrDcYGbmkycLV1eM9a`, not registered yet. Tested by `npm run test:lit-action`: 55 tests, including the negative test, #7. The backend relay is tested by `npm run test:unlock` (42 tests). Both suites were mutation-checked: planted bugs fail them. Every code-level checklist item is ticked; the live-account items are still open. |
| **Decrypt — live** | ❌ **Not working, and not safe to switch on as is.** Audited 2026-10-13: the Action is not registered, the frontend has no Lit settings, the reader's address is unauthenticated, and group 1 permits *any* action. See **[Build plan — rental decryption](#build-plan--rental-decryption)**. Re-checked live 2026-10-17: both holes reproduced, and the plan was amended (EIP-4361 message, session-bound release, backend relay, two RPC providers). See **[Review — 2026-10-17](#review--2026-10-17)**. |

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

The shape below is the requirement. The real Action follows it, with no hash parameter. Since 2026-10-17 its signature is `main({ ciphertext, authMessage, authSignature, sessionPublicKey })`:
1. It establishes *who* is asking from a signature first (see the Review, R2), before anything is unsealed.
2. It calls `Lit.Actions.Decrypt` and rejects any envelope that is not `v === 1` with a 32-byte `k` and an `arweaveHash`.
3. Only then does it check `isRentalActive(envelope.arweaveHash, signer)`, plus the uploader and librarian-review carve-outs.

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

Checked against `src/services/litAction.js` and `tests/decryptionAction.test.js` on 2026-10-13, and again on 2026-10-17 after the rebuild. Test numbers refer to the 52-test suite. Re-check after every edit to the Action.

- [x] The Action's parameters do **not** include `arweaveHash` (or any alias — `hash`, `txId`, `bookId`). *Signature is `main({ ciphertext, authMessage, authSignature, sessionPublicKey })`. Test 27 passes `arweaveHash`, `userAddress` and `pkpId` anyway; they change nothing.*
- [x] The sealed payload is unwrapped **before** the rental/uploader/librarian check runs. *Since 2026-10-17 the identity checks run first, and nothing is unsealed until they pass (tests 25, 30, 39). `Decrypt` still precedes the gate, which reads only the sealed hash.*
- [x] `isRentalActive` is called with the hash read from the decrypted envelope, and nothing else.
- [x] Envelope `v` is checked; unknown versions are rejected. *`envelope.v !== 1` → `invalid_envelope_format`.*
- [x] Every failure path returns without releasing the key — no `catch` that falls through. *Unseal and envelope errors return `{ error }` immediately. A failed contract read (rental, uploader, librarian state) sets that check to `false`, so the gate denies. The key is only released after the gate passes. Test 9: a paused Rent contract denies.*
- [x] A negative test exists: sealed key for book A + claimed hash for book B ⇒ **denied**. *Test 7, "renting book A does not unlock book B". The Action has no hash parameter, so the claim cannot even be expressed.*
- [ ] Only the reviewed Action's IPFS CID is permitted against the PKP; the permitted list has been enumerated and has no leftovers. *Not verified: needs the live Lit account (`npm run lit:register` output plus a listing of the group's actions).*

The negative test is the one that matters. Everything else can pass while the system is fully exploitable.

**Added by the build plan below. Each is open until its step is done:**

- [x] The Action takes **no `userAddress` parameter**. The reader's address is recovered from the wallet signature inside the TEE (`ethers.utils.verifyMessage`) and must equal the message's address line. A contract wallet's signature is denied until R1 is built. *Tests 24 (named Alice, signed by Eve), 26 (garbage signature), 27 (a `userAddress` param is ignored).*
- [x] A message whose `domain` is not on the Action's allowlist is **denied**, even with a valid signature (R2). *Test 32. The allowlist is `['localhost:5173']`.*
- [x] The Action never returns a plain `k`. It returns `k` only wrapped to the session public key whose hash is in the signed message, and a mismatched session key is denied (R3). *Tests 29 and 50 (no response across the whole run carried `key` or `k`), and test 52 (a wrapped key does not open with another session key).*
- [x] The backend relay never receives or logs a plain `k`, and forwards only `{ wrappedKey, grantedVia }` (R4). *Relay tests 21 (a plain key is refused, not relayed, not logged), 3 (the sealed key comes from Postgres only), 31 (nothing logged echoes a request).*
- [x] Every chain read the gate depends on needs two independent RPC providers to agree, and disagreement or an error denies (R5). *Tests 44–48. The clock is the newer of the two, and the clocks must agree to within 60 s (tests 43–45).*
- [x] The signed message is bound to this book's sealed key and expires. A stale, future-dated or other-book signature is denied. *Tests 31, 38, 40, 41.*
- [x] `pkpId` is a constant inside the Action, not trusted from `js_params`. *Test 28: every `Decrypt` used the constant, even when a `pkpId` param was passed.*
- [x] No Lit key ships in the frontend bundle. *`VITE_LIT_*` removed; `lit.js` calls the backend relay.*
- [x] The uploader door opens only for the wallet that staked the book: `getUploader(hash) == reader` **and** `stakes(hash).staker == reader`. *Tests 53 (never staked: denied), 54 (active stake: let in), 55 (a stake naming someone else: denied); 3, 4 and 10 run on an approved book whose stake was withdrawn, which still opens. Mirrored by the relay and decrypt-params (`stake_required`).*
- [ ] No group on the account contains the `Any` action or the `0x000…` wallet (step D).
- [ ] The reader key (`LIT_READER_API_KEY`, backend only) can execute in the decrypt group **only**, with no manage/create rights (step C).
- [ ] A hand-written Action that calls `Lit.Actions.Decrypt` without any checks is **refused** by the live account (step E, test E5; R6 checks it early).
- [ ] A hand-written Action that calls `Lit.Actions.getPrivateKey({ pkpId })` is **refused** with both keys (step E5, R9 — only after step D).
- [x] No digest of the book key is stored or served: `litDataToEncryptHash` is `sha256(sealed envelope)` (R8; `tests/litSeal.test.js`, migration `20261017120000_hash_sealed_envelope`).

---

## Build plan — rental decryption

Written 2026-10-13. Goal: a reader with an active rental (or the uploader, or a librarian inside the review window) opens a book in the browser, and **nobody else can get the key, even by calling Lit directly.**

### How it works today (facts, checked 2026-10-13)

The envelope travels in one direction only. **The frontend never sends an envelope or key to the backend.**

```
UPLOAD (backend)                                   READ (browser)
1. random AES key k, encrypt PDF                   1. GET /api/storage/:hash/data → ciphertext
2. sign Arweave tx → arweaveHash                   2. GET /api/rental/decrypt-params → sealed envelope,
3. Lit (encrypt Action, PKP) seals                    IV, auth tag
   {v:1, k, arweaveHash} → sealed envelope         3. POST Lit /lit_action (decrypt Action):
4. Postgres: litEncryptedKeyId = sealed envelope      unseal → read arweaveHash inside → check chain
   (k is zeroed; ⚠️ backend CAN unseal until step D)  → return k
                                                   4. WebCrypto AES-GCM decrypt in RAM, watermark
```

What a live, read-only audit of the Lit account found (`list_actions`, `list_wallets_in_group`, `list_api_keys`, `get_lit_action_ipfs_id`):

| # | Finding | Effect |
|---|---|---|
| F1 | The decryption Action (`litAction.js`, CID `QmcDAyJfwFP29JtufMULaUxo6eTPdqvE6PvPfGJLxtgn6Q`) is **not registered**. The account has only `alexandria-encrypt`, `-v2`, `-v3`. | Every legitimate read fails. |
| F2 | The frontend `.env` has no `VITE_LIT_PKP_ID` / `VITE_LIT_API_KEY`. | Same: requests go out with an empty PKP and no key. |
| F3 | Group 1 contains the action **`Any` ("Any action received.")** and the wallet **`0x0000…0000`**, beside our PKP `0x97ac4b09…f2d2`. | Lit enforces "the named PKP must be in a group with the running CID" [S2]. With `Any`, every CID qualifies, so code that skips all checks may call `Decrypt` on our PKP. **The rental gate can be bypassed by not using our Action.** Proven live 2026-10-17 (T2). |
| F4 | The Action takes `userAddress` as a plain `js_param`. | Who rented what is public (`BookRented` events). Anyone can claim a renter's or the uploader's address and receive `k`. The hash binding above does not help with this. Proven live 2026-10-17 (T3). |
| F5 | The only usage key (`alex-encrypt`, the backend's `LIT_API_KEY`) has `execute_in_groups: [0]`, `manage_ipfs_ids_in_groups: [0]`, `add_pkp_to_groups: [0]` and `can_create_groups: false`. | Far more than encryption needs. It must never go into the browser. It also **cannot create groups**, so steps C/D need the account (master) key. |
| F6 | The backend's encrypt code hashes to CID `QmdCwzJt5Xvs5PVh6Dozt8jmG8pT6hNdxDqTqNL6vQ1heB`; `keccak256` of that string is `0x1ef7e789…2a41` = **`alexandria-encrypt-v3`**. | `-v1` and `-v2` are leftovers, safe to remove. Also shows the `hashed_cid` the API uses is `keccak256(utf8(CID))`. |
| F7 | The frontend `.env` is **tracked in git** despite `.gitignore`. | A key written there gets pushed to GitHub. |
| F8 | `Reader.jsx` falls back to the address `0x000…0` when no wallet is connected. | Has to go once the reader must sign. |

What Lit documents (sources at the end of this section):

- `Lit.Actions.Decrypt({ pkpId, ciphertext })` → `Promise<string>`, the plaintext; `Encrypt({ pkpId, message })` → `Promise<string>` [S3]. Described as encryption "with a PKP-derived AES key" [S1].
- Every `Encrypt`/`Decrypt` "is checked again: the named PKP must be in a group with the running CID"; the server first checks "that the API key may execute in a group containing that CID" [S1].
- `ethers` **v5** is a global in the runtime [S1].
- Lit's recommended pattern: "require the caller to sign a challenge and verify the signature cryptographically inside the action", using `ethers.utils.verifyMessage`, and the message "should include a nonce or timestamp so that a previously captured signature cannot be replayed" [S4].
- Usage keys are "scoped, rotatable keys … least-privilege"; the account key is "the master credential" and is what creates usage keys [S5]. `execute_in_groups: [0]` means all groups [S6].
- `X-Privacy-Mode: true` stops the server writing `js_params` and the action output to its logs [S6].
- Limits: 15 min run time, 10 key operations, 50 outbound fetches, 1 MB response [S7].

### Target design

> ⚠️ **Revised by the [2026-10-17 review](#review--2026-10-17).** Step 1 stays `ethers.utils.verifyMessage`, because readers use ordinary browser-extension wallets (R1 is deferred). The changes:
> - **Message:** becomes EIP-4361 (Sign-In with Ethereum) with a domain allowlist (R2).
> - **Response:** the Action returns `k` only wrapped to a per-read browser key (R3).
> - **Path:** the call goes through a backend relay (R4).
> - **Chain reads:** every one needs two RPC providers to agree (R5).
>
> The concrete changes are in **Plan changes** in that section.

```
async function main({ ciphertext, authMessage, authSignature })     // no pkpId, no userAddress
  PKP_ID = '<constant>'                                             // not caller-chosen
  1. user  = ethers.utils.verifyMessage(authMessage, authSignature)  // the only identity
  2. parse authMessage; require
       - Key    == sha256(ciphertext)    → the signature unlocks THIS sealed key only
       - Wallet == user                  → message and signer agree
       - now    = latest Base Sepolia block timestamp (same clock as the librarian check)
       - Issued <= now + 60 s,  now < Expires,  Expires - Issued <= 600 s
  3. Decrypt({ pkpId: PKP_ID, ciphertext }) → envelope; check v === 1, k, arweaveHash
  4. existing gate, unchanged: rental | uploader | librarian review  (for `user`)
  5. return { key: k, grantedVia }
```

The message the wallet signs (EIP-191 `personal_sign`, readable in every wallet prompt):

```
Alexandria: unlock a book
Key: <sha256 hex of the sealed envelope>
Wallet: <0x… lower-case>
Issued: <unix seconds>
Expires: <unix seconds>
```

Why each piece:

| Piece | Stops |
|---|---|
| Address recovered from the signature, no `userAddress` param | F4: claiming someone else's rental. Same rule as `arweaveHash`: a parameter that does not exist cannot be misused. |
| `Key: sha256(sealed envelope)` checked inside the TEE | Reusing a signature for a different book. |
| `Expires`, at most 10 minutes, checked against the chain's clock | Replay of a captured signature after that. The signature only travels browser → Lit over HTTPS, and `X-Privacy-Mode` keeps it out of Lit's logs. |
| `pkpId` constant in the code | Pointing the Action at a different PKP. Lit already limits a caller to PKPs in the group [S4]; this makes it explicit and part of the reviewed CID. |
| Group 2 = this CID + our PKP only; bundle key executes in group 2 only | F3 and F5: running anything else against the PKP with the public key. |

No nonce store is used, because a Lit Action has no persistent storage to keep one in. The short expiry plus the key binding is the replay protection. Known limitation: **smart-contract wallets (EIP-1271) will not verify** with `verifyMessage`. Only ordinary (EOA) wallets can read until that is added.

**Rejected:** relaying the Lit call through the backend so the API key stays off the browser. The Action's response *is* `k`, so the backend would see every book's key. That breaks "the backend is never in the decryption path" (§3) and the rule that the backend never holds a raw key. *Reconsidered in R4: with session-bound release (R3), the response is a wrapped `k` the backend cannot open.*

### Steps

> ⚠️ **Amended by the [2026-10-17 review](#review--2026-10-17)**, under "Plan changes": a group test runs before step B, step B gains a backend relay, and the reader key goes to the backend instead of the bundle.

Each step is done and checked before the next starts. **A**, **B** are code only. **C–E** write to the live Lit account (metered credits), and **E** also spends a little AR and Base Sepolia gas.

**A. Branches** ✅ 2026-10-13. Frontend `Development` (`19a248f`) now contains the Arweave read path (PR #15/#16). Both repos' `ALEX-DecryptingRental` sit on their `Development`.

**B. Authenticated Action (code + tests, nothing live)**
1. `src/services/litAction.js`: new signature `main({ ciphertext, authMessage, authSignature })`, a `PKP_ID` constant, and the checks in "Target design". Every failure returns `{ error }` and stops:
   `bad_signature`, `auth_message_invalid`, `auth_wrong_key`, `auth_wallet_mismatch`, `auth_expired`, `auth_not_yet_valid`, `auth_window_too_long`, `clock_unavailable`.
   Envelope and gate stay as they are.
2. `src/services/lit.js`: `unwrapKeyFromLit(sealed, signer)` builds the message, asks the wallet to sign (`signer.signMessage`, ethers v6 already in the frontend), sends `X-Privacy-Mode: true`, and maps the new errors to readable text.
3. `src/pages/Reader.jsx`: require a connected wallet (remove the `0x000` fallback, F8). Add the step "Sign to prove it's your wallet" to the loading list, and show a clear message if the wallet declines.
4. `tests/decryptionAction.test.js`: the simulator's `ethers` gains real `utils.verifyMessage` / `utils.sha256` / `utils.toUtf8Bytes` (v5 names, backed by the frontend's ethers v6 with real keys). Keep all 23 existing tests, re-pointed to signed calls, and add:
   - a renter's address in the message, signed by someone else → `bad_signature`/`auth_wallet_mismatch`
   - a valid signature for book A sent with book B's envelope → `auth_wrong_key`
   - expired, future-dated, and > 10-minute windows → denied
   - an unreadable block clock → denied
   - no `userAddress`/`pkpId`/`arweaveHash` parameter is read, even if passed
   - exactly one response on every path (already enforced by the harness)
5. Re-pass this file's checklist, including the new items, and update the CLAUDE.md files in both repos.
6. Print the new CID with `npm run lit:register` (a dry run, which is free).

**C. Lit account: decrypt group and public key** (needs the **account key**, F5; supplied in the shell for the run, never written to a file)
1. `add_action` for the step-B CID.
2. `add_group` "Alexandria decrypt" with `pkp_ids_permitted: [our PKP]`, `cid_hashes_permitted: [keccak256(CID)]`.
3. `add_usage_api_key` "alex-reader": `execute_in_groups: [<new group>]`, everything else `false`/`[]`. The response shows the key once.
4. Frontend: `git rm --cached .env` (F7; the file stays on disk), then set `VITE_LIT_PKP_ID` and `VITE_LIT_API_KEY` there. `.env.example` keeps the names only. *(Superseded: no Lit key goes in the frontend (R4), and the `git rm --cached .env` is staged as of 2026-10-17; see the code review below.)*
5. `scripts/lit-register-decrypt-action.js`: target the decrypt group instead of the default group 1, and list that group's actions and wallets at the end.
6. Wait for the permissions to take effect by polling a real call rather than sleeping a fixed time, as the docs recommend [S6].

**D. Lit account: lock down group 1 and the backend key** (needs the account key)
1. `remove_action_from_group` (group 1): `Any`, `alexandria-encrypt` (`0xa28cbc1e…`), `alexandria-encrypt-v2` (`0xa1afc098…`). Keep `-v3` (F6).
2. `remove_pkp_from_group` (group 1): `0x0000…0000`. Keep our PKP.
3. `update_usage_api_key` `alex-encrypt` → `execute_in_groups: [1]`, every manage/add/remove right empty.
4. Re-run `node tests/encryption.manual.js` right after, to prove backend sealing still works. If it fails, restore that item before going further, because uploads depend on it.

**E. Live tests** (one small book through the real pipeline)
1. A fresh throwaway archivist wallet. Upload a small random PDF, wait for `pending`, which means it is registered on Base Sepolia with that wallet as `uploader`.
2. **E1:** first sign as the uploader **before staking** → `stake_required` (the uploader door needs a stake, 2026-10-17). Then stake 100 ALEX from that wallet and sign again → book opens, `grantedVia: uploader`. This proves `Decrypt` works across groups (sealed in group 1, opened in the decrypt group) and the stake-gated door live. Open the book a second time: no signature prompt and no Lit call (the key kept in IndexedDB).
3. **E2:** a message naming the uploader, signed by another wallet → denied.
4. **E3:** a wallet with no rental → `access_denied`.
5. **E4:** an expired message → `auth_expired`.
6. **E5:** a hand-written Action that only calls `Decrypt`, run with the `alex-reader` key and with the `alex-encrypt` key → both refused. This is the F3 proof. Also run one that calls `Lit.Actions.getPrivateKey({ pkpId })` with both keys → both refused (R9). Only after step D: before it, this would succeed and expose the PKP secret.
7. **E6:** with the `alex-reader` key, try `add_action` and `add_group` → both refused.

The **rental** path cannot be tested live straight away. `Rent.rentBook()` requires an **Approved** book, and a new upload stays Pending for the 14-day challenge window. Until a book is approved, the rental path is covered only by the simulated tests (they share the gate code with E1). It still has to be checked live once a book is approved.

### Things not known yet (measured in step E, not assumed)

| | Question | Measured by |
|---|---|---|
| U1 | Does `Decrypt` return a bare string live, as documented [S3]? The Action also accepts `{decrypted}` / `{plaintext}` today. | ✅ **Yes**, 2026-10-17 (T2) |
| U2 | Does a key sealed while running in group 1 decrypt while running in another group with the same PKP? The docs say the AES key is "PKP-derived" [S1], which suggests yes, but this is unconfirmed. | Still open: needs the account key (R6). Do it first in step C. |
| U3 | Is `ethers.utils.verifyMessage` present and identical in the live runtime? | ✅ Yes, `ethers/5.7.2` (T2). It only covers ordinary (EOA) wallets, though; see R1. |
| U4 | How long do new permissions take to apply? | C6 |
| U5 | Does removing `Any` from group 1 change anything for the backend's encryption? | D4 |
| U6 | What does one `/lit_action` call cost, and what does a key's `balance` field (`10000000` on `alex-encrypt`) mean? Neither is documented [S7]. This matters because the reader key is public and anyone can spend with it. | Partly measured (2026-10-17): **~1 cent per call**, denials included. `balance` is still unexplained. See R4. |
| U7 | Readers use browser-extension wallets (MetaMask, Rabby). Do they enforce the EIP-4361 domain rule, so a message naming `localhost:5173` that is requested from another site gets rejected? | E2, with each wallet |
| U9 | The rebuilt Action also uses `ethers.providers.StaticJsonRpcProvider` and `ethers.utils.toUtf8Bytes`, which are standard in ethers 5.7.2 but were not probed live (T2 probed `JsonRpcProvider`, `verifyMessage`, `sha256`, `base64`). | E1: the first live unlock exercises every one |
| U8 | Can the Lit runtime wrap `k` to a browser's public key (needed for R3)? | ✅ **Yes**, 2026-10-17 (T5): RSA-OAEP-256 `importKey('spki')` + `encrypt` work in the Action, and WebCrypto `unwrapKey` gives a non-extractable AES-GCM key that decrypts correctly. The unwrap side ran in Node's WebCrypto; E1 repeats it in a browser. |

### Sources

- [S1] Lit Actions overview, https://developer.litprotocol.com/lit-actions.md
- [S2] Same page, permissions: "the named PKP must be in a group with the running CID"
- [S3] Lit Actions SDK reference, https://developer.litprotocol.com/lit-actions/chipotle
- [S4] Patterns, https://developer.litprotocol.com/lit-actions/patterns
- [S5] API keys, https://developer.litprotocol.com/management/api_keys
- [S6] Direct API, https://developer.litprotocol.com/management/api_direct.md
- [S7] Limits, https://developer.litprotocol.com/lit-actions/limits
- Live account reads: `list_actions`, `list_groups`, `list_wallets_in_group?group_id=1`, `list_api_keys` (metadata only), `get_lit_action_ipfs_id`, all on 2026-10-13

---

## Review — 2026-10-17

This is a second pass over the build plan, using the owner's answers and a live test. **Nothing on the Lit account was changed.** The only calls were reads, plus five `/lit_action` calls made with a throwaway key.

The goal is unchanged: a reader opens a book in the browser. The order of the plan is right too. Simply registering today's Action and shipping a key (fixing F1 and F2 alone) would switch on a decrypt path that the live test showed anyone can abuse.

### Owner's answers

| Question | Answer | What it changes |
|---|---|---|
| Should rentals be time-bound? | Yes | R3: only the *release* of the key can be time-bound. Keeping the book after release cannot be prevented, and the docs have to say so. |
| What is group 1 for? | Encryption only. Decryption goes in a new group 2. | Matches steps C and D. But group 1 does **not** hold only encryption today (see below). |
| Live test allowed? | Yes | Done, see below. U2 needs the account key, so the owner runs R6. |
| Credit budget for a public key? | Not sure | R4: the measured cost and the options. |
| Which wallets will readers use? | **Browser-extension wallets** (MetaMask, Rabby) | Ordinary wallets, so `ethers.utils.verifyMessage` works and **R1 is deferred**. An earlier answer of "smart-contract wallets" came from a badly worded question, which read as if it were about the Rent contract. |
| Use EIP-4361 (Sign-In with Ethereum)? | Yes in principle, needs checking | R2: checked, adopted. |
| Which domain does the frontend run on? | Only `localhost` for now; hosting is not chosen yet | R2: the allowlist is `localhost:5173` until a host is chosen. |
| Adopt session-bound release (R3) and the backend relay (R4 b)? | Yes | Adopted. |
| Require two RPC providers to agree (R5)? | Yes | Adopted. |
| How will the account key be supplied? | The owner runs a script in their own terminal | R6: `scripts/lit-group-probe.mjs` |

### Live state of the Lit account (read 2026-10-17)

- **Group 1** ("Alexandria", the only group) permits these actions: **`Any`**, `alexandria-encrypt`, `-v2` and `-v3`. It permits these wallets: **`0x0000…0000`** and our PKP `0x97ac4b09…f2d2`. Nothing has changed since F3 was found on 2026-10-13.
- **Usage keys:** there is one, `alex-encrypt`. It can execute, manage IPFS ids, and add **and remove** PKPs in every group (`[0]`). It cannot create or delete groups or PKPs. Its `balance` field is `10000000`.
- **Account credit:** $4.70 before the test, $4.65 after.

### Live test (2026-10-17)

The test sealed a throwaway random 32-byte key into `{ v: 1, k, arweaveHash: "0Nefi7ad…MCA" }`. That hash belongs to a real registered book, so the on-chain checks had something to find. **No real book's envelope was decrypted.** Every call used the backend's `alex-encrypt` key and `X-Privacy-Mode: true`.

| # | Call | Result | What it shows |
|---|---|---|---|
| T1 | Seal the throwaway envelope with the registered encrypt-v3 code | `response` is a **bare hex string** (292 chars), not JSON | `sealKey` always takes its fallback path, so `dataToEncryptHash = sha256(envelope)` |
| T2 | An **unregistered** probe Action calls `Lit.Actions.Decrypt` on our PKP | It decrypted, and returned the original envelope exactly as a **bare string** | **F3 is real**: any code can use our PKP in group 1. **U1**: `Decrypt` returns a plain string. |
| T2 | Runtime probe | `ethers/5.7.2`. `ethers.utils.verifyMessage` works (round trip with a random wallet). `fetch` and `crypto.subtle` exist. The Base Sepolia RPC is reachable (block 48235041). | **U3**, for ordinary wallets. `getCode(0xE1F4…7A06)` returned 0 bytes. |
| T3 | The real frontend Action (CID `QmcDAyJf…n6Q`, unregistered: it runs only because of `Any`), with `userAddress` set to the book's uploader and **no signature** | `{ key: <throwaway k>, grantedVia: "uploader" }` | **F4 is real.** It also shows the whole Action works live end to end: unseal, envelope check, three contract reads, release. |
| T4 | The same Action with a random address | `{ error: "access_denied" }` | The gate denies live |
| T5 | A probe Action imports an RSA-OAEP-256 public key (`spki`) and encrypts 32 fixed test bytes to it. WebCrypto then unwraps the result into an AES-GCM key. | Wrapped (344 base64 chars). The unwrapped key has `extractable: false`, `exportKey` is refused, and it decrypts data encrypted under the test bytes. | **U8**: session-bound release (R3) works in the Lit runtime |

**Cost:** about **1 cent per `/lit_action` call**, whatever the call does. The six calls cost $0.06, and a denial costs the same as a release.

Two consequences that were not written down before:

- ⚠️ **The backend can unseal every book today.** T2 ran on the backend's own key. The diagram above says the backend can never unseal, and that stays false until step D removes `Any` and limits `alex-encrypt` to group 1. Anyone holding the server's `.env` can read the two live books now.
- **The live test book's uploader is an ordinary wallet.** Its address, `0xE1F4…7A06`, has no code, so it is an EOA. That is consistent with readers using browser-extension wallets.

### Changes the review requires

**R1. Smart-contract wallets: verify with ERC-6492, then ERC-1271, then ecrecover** (⏸ **deferred**: readers use ordinary browser-extension wallets, so `ethers.utils.verifyMessage` stays. A contract wallet's signature does not recover to its address, so it is denied, which fails closed. Build this only if contract wallets such as Coinbase Smart Wallet or Safe are ever supported.)

A contract wallet has no private key that `ecrecover` could check a signature against. The wallet contract decides instead: under ERC-1271, `isValidSignature(hash, sig)` returns `0x1626ba7e` when the signature is valid [S8]. A wallet that has never sent a transaction on this chain is not deployed yet, so there is no contract to ask. Such wallets wrap the signature in ERC-6492 format: factory, calldata and inner signature, ending in the magic bytes `0x6492…6492` [S9].

So the Action can no longer *recover* an address. It reads the address **from the signed message** and asks the chain whether that address signed it:

1. If the signature ends with the ERC-6492 magic bytes, or the address has code: run ERC-6492's `ValidateSigOffchain` helper. It is one `eth_call` with no deployment, and `0x01` means valid [S9]. This covers both deployed and undeployed contract wallets.
2. Otherwise (no code and no wrapper): use `ethers.utils.verifyMessage` and compare. This keeps ordinary wallets working, such as the live test book's uploader.
3. Always check on Base Sepolia, chain 84532. EIP-4361 says the verifying contract "MUST be resolved from the specified chain-id" [S10].

Notes:
- **Copy the helper's bytecode verbatim.** The `ValidateSigOffchain` bytecode comes straight from ERC-6492 into the Action, so it becomes part of the reviewed CID. Record where it came from in a comment.
- **Check the inner signature.** Accepting an ERC-6492 wrapper without checking the inner signature is a known class of bug [S11]. Test it: a wrapper around a garbage inner signature must be denied.
- **A lying wallet contract gains nothing.** A malicious contract that answers "valid" to everything can only impersonate *itself*, and the gate then checks *its* rentals.
- **Most readers' wallets are already deployed.** A renter has called `rentBook`, and a librarian has staked. The exception is an archivist opening their own book before staking, because the backend registered it for them. That case needs ERC-6492.
- **Wallets with delegated code (EIP-7702)** have code but sign like an ordinary wallet. Test them if any reader uses one.

**R2. The signed message: EIP-4361 (Sign-In with Ethereum)** (✅ adopted)

EIP-4361 requires wallets to reject a request whose `domain` does not match the requesting site, so a phishing site cannot get a message naming our domain signed. That protection only works if **the Action rejects every other domain**. Otherwise the phishing site puts its own domain in the message, the wallet sees a match, and the signature still works on our Action.

```
<domain> wants you to sign in with your Ethereum account:
<0x… EIP-55 checksummed>

Unlock one Alexandria book for reading.

URI: https://<domain>
Version: 1
Chain ID: 84532
Nonce: <16 random letters/digits>
Issued At: <RFC 3339>
Expiration Time: <RFC 3339>
Resources:
- urn:alexandria:sealed-key:sha256:<hex of the sealed envelope>
- urn:alexandria:session-key:sha256:<hex of the session public key, spki>   (R3)
```

The Action parses this strictly: exact line order, no extra lines. It requires all of the following:
- `domain` is in a constant allowlist
- `Chain ID` is 84532 and `Version` is 1
- the sealed-key resource equals `sha256(ciphertext)`
- the session-key resource equals `sha256(sessionPublicKey)`
- `Issued At` ≤ now + 60 s, now < `Expiration Time`, and the window is at most 600 s, with "now" taken from the latest block as before

Differences from the message in the 2026-10-13 plan:
- **Format:** times are RFC 3339 strings, not unix seconds. The spec also requires a nonce of at least 8 letters or digits [S10].
- **Replay protection:** the nonce is not checked against a store, because the Action has nowhere to keep one. Expiry and the key binding remain the replay protection.
- **Domain changes:** the allowlist is a constant, so changing the frontend's domain changes the CID and needs re-registration.
- **Not verified:** whether MetaMask and Rabby actually enforce the domain rule (U7).
- **Address check:** the address line must equal the address recovered by `verifyMessage`.

**The allowlist is `localhost:5173` for now.** No host has been chosen, and 5173 is Vite's default port; `vite.config.js` sets none. This still blocks phishing: a site elsewhere cannot get a wallet to sign a message naming `localhost:5173`, because the domain does not match its origin (U7 checks that wallets really refuse).

Two consequences:
- **Pin the port.** Set `server: { port: 5173, strictPort: true }` in `vite.config.js`. Otherwise Vite quietly moves to 5174 when 5173 is busy, and every unlock fails with `auth_domain`.
- **Choosing a host changes the CID.** It needs one more registration, so add the domain to the allowlist at the same time.

**R3. Time-bound rentals: what can and cannot be enforced** (✅ session-bound release adopted; U8 answered yes)

What is enforced: every *release* of `k` needs a rental that is active **at that moment**, checked in the TEE against the chain. After the rental expires, the app cannot get the key again.

What cannot be enforced, by this design or by any design where the browser decrypts:
- **`k` is fixed per book.** The ciphertext on Arweave is permanent and public, so `k` can never be rotated without uploading the book again.
- **`k` and the PDF are both reachable today.** `k` arrives as a base64 string in the Lit response and in page JavaScript, and the decrypted PDF sits in memory for PDF.js. A renter who saves either one keeps the book after the rental ends, and anyone they give `k` to can read it forever.
- **The watermark is not a barrier.** It is added in the browser *after* decryption, so it only marks copies made through an unmodified app.

So the honest claim is **time-bound access through the app**, not time-bound possession.

Proposed mitigation, **session-bound release**. It raises the bar but does not remove the limit:
1. The browser creates a non-extractable key pair for each read (WebCrypto, `extractable: false`).
2. The hash of its public key goes into the signed message as a second resource.
3. The Action checks that hash, encrypts `k` to that public key with `crypto.subtle` inside the TEE, and returns only the wrapped `k`.
4. The browser unwraps it directly into a non-extractable AES-GCM key.

Effects:
- **`k` is never readable.** It never exists as readable bytes in the page, the network response or Lit's logs.
- **A stolen signature is useless.** The TEE wraps `k` to a key that only the signer's browser holds, so a captured or phished signature gets nothing.
- **Still possible:** a determined reader can dump the decrypted PDF from memory, or take screenshots.

**Algorithm (measured in T5):** an RSA-OAEP-2048 key pair with SHA-256 per read. The Action imports the public key as `spki` and encrypts the 32 raw bytes of `k`. The browser calls `unwrapKey('raw', …, { name: 'AES-GCM' }, false, ['decrypt'])`. The second resource line in the signed message is `urn:alexandria:session-key:sha256:<hex of the spki bytes>`.

**Keys kept until the access ends (owner decision, 2026-10-17).** Every unlock is a metered Lit call (about 1 cent), and the rental fee does not fund it. So the browser keeps the unwrapped key in **IndexedDB**, not localStorage, which can only hold text and would need the key exported. Re-opening the book then costs no signature and no Lit call (`src/services/keyStore.js`).
- **What is stored:** the `CryptoKey` object itself, still non-extractable: the page can decrypt with it, `exportKey` is refused, and other sites cannot see it. Structured cloning (how IndexedDB stores values) keeps it that way; checked with a key unwrapped exactly as `lit.js` does.
- ⚠️ **Non-extractable is a promise of the JavaScript API, not of the disk.** The browser writes the key's bytes into its profile folder, so someone with file access to that profile and the right tools could recover them. A shared computer is the case to keep in mind. That is no easier than dumping the decrypted PDF from memory, which any renter can do while reading.
- **Scope:** one entry per wallet and book, so two wallets in one browser never share a key.
- **How long:** a rental until its on-chain expiry; an uploader with no end; a librarian review one day at most.
- **Before every use:** the free access check (`GET /rental/decrypt-params`). A 403 or 409 deletes the stored key. Expired entries are swept whenever the Reader opens. A stored key that fails to decrypt is deleted and the book unlocked afresh.
- **What it changes:** the key now outlives the read, but not the access. That is no weaker than before. The renter already holds the decrypted PDF while reading. A stored key cannot be read out, unlike the base64 key the first design returned. And the time limit was always the app's own rule (see above).
- **Costs one more unlock:** cleared site data, a private window (IndexedDB is wiped when it closes), another browser or device, or the browser evicting storage under disk pressure.

**R4. Credits: a public reader key can drain the account** (✅ option (b) adopted: the backend relay, together with R3)

Measured: about 1 cent per call, with $4.65 left, which is roughly 465 calls. Once the reader key is in the bundle (step C), anyone can extract it and spend the whole balance in a loop, and denials cost the same as releases. When the balance runs out, **uploads stop too**, because backend sealing uses the same account. Lit documents no rate limit, no per-key budget, and no meaning for a key's `balance` field [S5][S7].

Options:
- **(a) Ship the key, alert on balance, top up.** This is the simplest option, but a cheap attack can still stop both reads and uploads.
- **(b) Relay the Lit call through the backend.** The key stays on the server, and the backend can rate-limit per wallet. This is **only acceptable together with R3**. With session-bound release, the backend forwards a signed request and receives a wrapped `k` that it cannot open. It also cannot swap the session key, the book or the Action without breaking the signature or the group's CID check. That removes the reason the relay was rejected above (that the response *is* `k`). Reads already depend on the backend for the ciphertext and decrypt-params, so availability does not get worse.

What the relay looks like:
- **Route:** `POST /api/rental/unlock/:arweaveHash`. Body: `{ code, authMessage, authSignature, sessionPublicKey }`. The sealed key is read from Postgres by the hash in the path, never taken from the request, so the signed sealed-key hash has to name that book. `code` must hash to `LIT_DECRYPT_ACTION_CID`.
- **Cheap checks before spending a credit.** The backend checks the same things the Action will: message format, domain, expiry, signature, the sealed-key and session-key hashes, and the rental, uploader or librarian gate (the logic of `getDecryptParams`). It forwards only requests that should pass, so a stranger's requests cost nothing.
- **Rate limit per recovered wallet** (3 per 10 minutes), well below the global ceilings (60 an hour, 300 a day), so one wallet with access cannot drain the balance or take every reader's share.
- **Credit reserve:** below `UNLOCK_MIN_CREDIT_CENTS` (default 100) of Lit credit, unlocks stop with `503 unlock_budget_low` and the server warns, so reads never spend the credit uploads need.
- **Books not on-chain yet** (`pending_confirmation`, `pending_stake`, `storage_failed`) get `409 not_registered` and are never forwarded. The Action reads the uploader from the chain and would refuse them.
- **Forwarding:** `/lit_action` is called with a new key, `LIT_READER_API_KEY` (`alex-reader`, which executes in group 2 only), plus `X-Privacy-Mode: true`. The Action's response is returned unchanged. Request and response bodies are never logged.
- **No Lit key in the frontend bundle.** Step C4 changes: no `VITE_LIT_API_KEY`. F7 (the tracked frontend `.env`) still needs fixing.
- **Order:** the relay ships together with R3, never before it. A relay that sees a plain `k` breaks the rule that the backend never holds a raw key.
- **Documentation:** CLAUDE.md "the backend is never in the decryption path" becomes "the backend relays the unlock request but can never read the key". Update it when this is built.

**R5. The RPC endpoint is a trust anchor** (✅ adopted)

"RPC" here means the **Base Sepolia blockchain providers**, not Lit. An RPC provider is a server that answers questions about the chain, such as "is this rental active?". The Action runs inside Lit's TEE but has no copy of the blockchain, so it asks a provider over HTTPS. Lit's own nodes are not involved in these reads.

Every check the Action makes is an answer from one RPC endpoint, `base-sepolia-rpc.publicnode.com`. That covers the rental, uploader and librarian checks, and the block time used for expiry. The TEE cannot check chain state itself, so an endpoint that is compromised or answers wrongly unlocks every book.

Adopted: ask two independent endpoints, publicnode and `sepolia.base.org` (the same pair the backend fails over between), and release the key only if both say yes. Any disagreement or error denies.

For the clock, the two block timestamps must agree to within 60 s, and "now" is the **newer** one. (Corrected 2026-10-17: this note first said "older", which is backwards. With the older clock, a lagging or lying provider could revive an expired signature or reopen a closed review window. Tests 43 and 45 pin this down.) The cost is twice the fetches, which is still well under the limit of 50. The trade-off is more denials whenever `sepolia.base.org` is unhealthy.

**R6. U2 is still the riskiest unknown** (script ready; the owner runs it)

U2 cannot be measured without the account key, because `alex-encrypt` cannot create groups. **`scripts/lit-group-probe.mjs`** does it. The owner runs it in their own terminal, from the backend folder:

```
node --env-file=.env scripts/lit-group-probe.mjs
```

It asks for the account key at a hidden prompt, holds it only in memory, and redacts every key from its output. Then it:
1. Seals a throwaway envelope in group 1 with the backend key, which is the real upload path.
2. Runs a **baseline** in group 1, which works only because of `Any`. This rules out a broken probe.
3. Creates the group **"Alexandria decrypt"** with our PKP, and permits a test action there. The test action only reports whether it decrypted and whether the hash matched; it never returns plaintext, so it is harmless even if cleanup fails.
4. Creates a temporary usage key that can execute in that group only.
5. **U2 and U4:** runs the test action with that key, polling every 10 s for up to 3 min, and records how long the new permissions took to apply.
6. **Early E5/E6 checks:** with the same key, unpermitted code and the group 1 encrypt action must both be refused, and so must `add_group`.
7. **Cleanup:** deletes the temporary key and the test action. It **keeps** the "Alexandria decrypt" group, holding only our PKP, for step C.

Expected: U2 `DECRYPTED, matches`, and all three negative checks refused. If U2 fails, the decrypt Action has to live in group 1, and the lock-down in step D becomes the only barrier.

**R7. Small items**

- **Remove the fallbacks in `lit.js`** (✅ done 2026-10-17). The old `lit.js` accepted a bare string as the key and treated a missing `grantedVia` as `rental`. `unlockBookKey` now requires a `wrappedKey` and one of the three known `grantedVia` values, or it errors.
- **`alex-encrypt` can also *remove* PKPs** from any group, which F5 does not list. Step D3 already empties that right.

**R8. `litDataToEncryptHash` was a hash of the book key** (✅ fixed 2026-10-17)

Chipotle's `Encrypt` returns the ciphertext alone (T1). `dataToEncryptHash` is a field from the Datil-era SDK, and Chipotle never returns it. So `sealKey` always fell back to `sha256(envelope)`, and that `envelope` was the **plaintext** `{"v":1,"k":…,"arweaveHash":…}`. Its comment said the opposite, and named the wrong column. Every row therefore stored, and decrypt-params served, a fingerprint of the book's AES key.

It was not exploitable: a 256-bit key cannot be recovered from its hash. But it let anyone confirm a guessed key, and it broke the rule that no digest of key material is kept.

Now it holds `sha256(sealed envelope)`, which is public ciphertext and exactly the sealed-key hash a reader signs in the unlock message. Any `dataToEncryptHash` Lit might supply is ignored.

| Part | Where |
|---|---|
| Code | `controller/litProtocol.js` |
| Tests | `tests/litSeal.test.js`, 8 tests. Re-planting the old fallback fails 4 of them. |
| Backfill | Migration `20261017120000_hash_sealed_envelope` recomputes existing rows. Its SQL was checked against Node's hash on the live Postgres (18.6). |
| Live check | One live seal through the real `sealKey`: stored hash = `sha256(sealed)` |

Hashing is not what protects the sealed envelopes: they are public ciphertext either way. What protects them is that only permitted code can use the PKP (steps C/D).

**R9. `Lit.Actions.getPrivateKey({ pkpId })` can export the PKP itself** (open)

Lit documents `getPrivateKey`: "Get the private key for a PKP wallet". It is checked only against group membership [S3], and `Encrypt`/`Decrypt` use "a symmetric key derived from the secret key of the PKP". So code allowed to use our PKP can do more than open envelopes one at a time: it can **take the PKP's secret out of the enclave**, and whoever holds that secret can open every envelope offline, forever. Removing `Any` afterwards would not undo it.

- **Today:** `Any` in group 1 means anyone holding the backend upload key (`LIT_API_KEY`) could do this. Step D closes it.
- **Do NOT test this before step D.** While `Any` exists, a test call would succeed and put the real PKP secret in a response.
- **After step D:** E5 must also try `getPrivateKey` with both keys, and expect refusal.
- **If anyone untrusted ever held the upload key while `Any` was present,** treat the PKP as compromised. The remedy is a new PKP, with every envelope re-sealed inside the TEE by a one-off Action that holds both PKPs, so no `k` is ever exposed. The upload key has been in the backend `.env` only, as far as this review knows.

### Plan changes

These amend "Steps" above. Where the two disagree, this list wins.

**Progress (2026-10-17):** B1–B4 and B-relay are **built and tested**, frontend and backend: 52 Action tests, 31 relay tests, and every existing backend suite still passing. All three suites were mutation-checked, so planted bugs fail them. Nothing is committed or live.

The owner chose to run R6 after the code, so the code was written assuming U2 holds. If R6 shows it does not, only the group setup changes (steps C/D); the Action, relay and browser code do not depend on which group the Action runs in.

Remaining, in order:
1. R6 (`scripts/lit-group-probe.mjs`)
2. Step C: register CID `QmQ7zqvwrHMhnKFTcmWRQuLhNR4wnrDcYGbmkycLV1eM9a` (re-derive it with `npm run lit:register` first; any later edit to the Action changes it) in the decrypt group; create `alex-reader`; set `LIT_READER_API_KEY` and `LIT_DECRYPT_ACTION_CID` in the backend
3. Step D
4. Step E

- **Before B: run R6.** ~~If U2 fails, stop and redesign the groups before writing any code.~~ Deferred by the owner to after the code (see above).
- **B1 (Action).** ✅
  - Signature: `main({ ciphertext, authMessage, authSignature, sessionPublicKey })`.
  - Message: parse it as EIP-4361 against the allowlist `['localhost:5173']` (R2), and check both resources: the sealed key and the session key.
  - Wallet: recover the address with `verifyMessage`, which stays because R1 is deferred.
  - Chain reads: every one must agree across two providers (R5).
  - Response: `{ wrappedKey, grantedVia }`, never `k` (R3).
  - New errors: `auth_domain`, `auth_chain`, `auth_session_key`, `rpc_disagree`, `wrap_failed`, plus `session_key_invalid` and `missing_params`.
  - Order of checks, cheapest and safest first: shape, message, domain, chain, window length, the sealed-key and session-key bindings, signature, session key import, chain clock, expiry; **then** `Decrypt`; then the gate; then wrap.
- **B2 (`lit.js`).** ✅ `unlockBookKey()`; the message builder is shared in `src/services/unlockMessage.js`. Generate the session key pair (non-extractable), build and sign the message, POST it to the backend relay instead of to Lit, then unwrap into a non-extractable AES-GCM key. `decryptPdfInBrowser` takes that CryptoKey instead of a base64 key.
- **B3 (`Reader.jsx`).** ✅ Unchanged from the 2026-10-13 plan, plus `strictPort` in `vite.config.js` (R2). Also fixed a bug found on the way: `rentalExpiry` was recomputed from `Date.now()` on every render when sessionStorage had none, and it is an effect dependency. That re-ran the whole unlock pipeline on every state change, which would have meant a new signature prompt each time.
- **B-relay (new, backend).** ✅ `controller/unlock.controller.js`, `services/unlockAuth.service.js`, `services/unlockRateLimit.service.js`, `tests/unlockRelay.test.js`. It also pins the forwarded code to `LIT_DECRYPT_ACTION_CID`, and refuses (502) any Action answer containing a plain key. `POST /api/rental/unlock/:arweaveHash` as described in R4, with tests:
  - a bad request is never forwarded
  - the rate limit holds
  - bodies are never logged
  - the response passes through unchanged
- **B4 (tests).** ✅ 52 tests (55 since the stake-gated uploader door); signatures and session keys are real, and requests are built with the app's own builder. Add:
  - wrong domain → `auth_domain`
  - wrong chain id → `auth_chain`
  - session-key mismatch → `auth_session_key`
  - providers disagree → `rpc_disagree`
  - one provider down → denied
  - no response on any path contains a plain `k`
- **C3/C4.** The `alex-reader` key goes in the **backend** `.env` as `LIT_READER_API_KEY`, never in the frontend. The group "Alexandria decrypt" already exists after R6, so C2 becomes "add the real CID to it".
- **E.** Run every test in a real browser with MetaMask and with Rabby. Add **U7**: request a `localhost:5173` message from another origin, and the wallet must refuse.

### Code review against this plan (2026-10-17)

The Action, the browser client, the relay, the register script and the R6 probe all follow R2–R5, R7 and B1–B4. The order of checks in the Action matches B1 exactly. `npm run test:lit-action` (52) and `npm run test:unlock` (31 at the time; 40 after the fixes below) pass. The source at the time hashed to the recorded CID `QmXkkcLg…eXr5`. It has since changed: see "Stake-gated uploader door" below.

**Live smoke test of the rebuilt Action.** It ran in group 1, which still works only because of `Any`. It used a throwaway envelope bound to `0Nefi7ad…MCA` and a random wallet, and cost 3 cents ($4.64 → $4.61).

| # | Request | Result | What it shows |
|---|---|---|---|
| S1 | A random wallet signs for itself | `access_denied` | Every step ran in the real runtime without error, up to the gate: parse, `verifyMessage`, SPKI import, both providers' clocks, `Decrypt` with the constant PKP, and the reads on both providers. The simulator's ethers v6 stand-ins match `ethers/5.7.2`. |
| S2 | The same wallet's signature over a message naming the uploader | `auth_wallet_mismatch` | **F4 is closed**: the attack that released a key in T3 is now refused |

The success path (wrapping and returning the key) still needs a wallet that has access to the book, so it waits for step E.

**Findings** (all four ✅ fixed 2026-10-17; nothing committed):

| # | Fix | Tests |
|---|---|---|
| 1 | `git rm --cached .env` is **staged** in the frontend (`.env` is already in `.gitignore`; the file stays on disk). `lit:register` now asks for its key at a hidden prompt and refuses to run if `LIT_API_KEY` is set. Its dry run needs no key at all. `.env.example` and the frontend CLAUDE.md say so. | Dry run checked; refusal checked |
| 2 | Per wallet: 3 per 10 minutes (18 an hour, against a ceiling of 60). New daily ceiling: 300 (`UNLOCK_RATE_GLOBAL_PER_DAY`). New credit reserve (`UNLOCK_MIN_CREDIT_CENTS`, default 100): below it, unlocks answer `503 unlock_budget_low` and the server warns. The balance comes from `GET /billing/balance` (credit = −`balance_cents`, as measured), is cached for 5 minutes, and is read only for a call about to be paid for. If it cannot be read, unlocks continue (fail open) and the server warns, because the ceilings still bound the spend. | Relay 34–39b |
| 3 | `checkReadAccess` answers `notRegistered` for `pending_confirmation`, `pending_stake` and `storage_failed`, before the uploader door. Both decrypt-params and the relay return `409 not_registered`, so the reader is told before being asked to sign. The frontend explains the code. | Relay 32–33; chainReads (3 new) |
| 4 | R4's route bullet, the B-relay line, and the backend and frontend CLAUDE.md now say `POST /api/rental/unlock/:arweaveHash`. | — |

Every new test was mutation-checked: each fix was removed in turn, and its tests failed. All backend suites pass (unlockRelay 40, chainReads 97, readPaths 45, securityAndDedup 52, uploadFlow 61, storageWorker 78, arweaveConfig 45), and so does the frontend Action suite (52).

New unknown, **U9**: can a usage key that may only execute (`alex-reader`) read `/billing/balance`? The backend key could on 2026-10-17, but it had wide rights. Check it in step C. If it cannot, the reserve is not enforced and the server warns once every 5 minutes. Either fix the key's rights, or set `UNLOCK_MIN_CREDIT_CENTS=0` and watch the balance by hand.

The findings as found:

1. **F7 is still open, and it now matters more.** The frontend `.env` is still tracked by git. `npm run lit:register` reads its key from that file, and `.env.example` now says that key must be the account key or a usage key that can manage the group. One `git add .` would push the master key to GitHub. Run `git rm --cached .env` (step C4) **before** step C. Alternatively, make `lit:register` ask for the key at a hidden prompt, as `lit-group-probe.mjs` does.
2. **One wallet can use up the whole global budget.**
   - **The limits are equal.** The per-wallet default (10 unlocks per 10 minutes, so 60 an hour) equals the global ceiling (60 an hour).
   - **Access costs an attacker nothing.** Uploading any valid PDF makes that wallet the book's uploader: the backend pays for storage and registers it.
   - **The effect.** A single wallet can lock every other reader out for as long as it keeps going. It can also spend about $0.60 an hour, which empties the $4.61 balance in about 8 hours. After that, uploads stop too.
   - **Fix.** Set the per-wallet limit well below the global one (for example 3 per 10 minutes). Add a daily ceiling and an alert on the balance.
   - **Also note** that the limits are kept in memory, so they reset whenever the server restarts.
3. **The relay and the Action disagree about who the uploader is.**
   - **The two sources.** The relay's pre-check (`checkReadAccess`) reads `uploader` from Postgres, where the upload form put it without proof. The Action reads `getUploader` from the chain.
   - **The effect.** For a book that is not registered yet (`pending_confirmation`, `pending_stake` or `storage_failed`), the relay forwards the request, the Action denies it, and a credit is spent. During the 25–40 minutes before registration, an archivist who opens their own book gets "Access denied" after signing.
   - **Fix.** Have the relay answer those statuses with a clear 409 "not registered yet", or read the uploader from the chain, which costs nothing.
4. **The documentation has drifted from the code.**
   - **R4 "Route".** It still says `POST /api/rental/unlock` with `ciphertext` in the body. The code is `POST /api/rental/unlock/:arweaveHash` with `code` in the body, and it takes the sealed key from Postgres. The code is the better design.
   - **CLAUDE.md.** Lines 29, 226 and 331 leave out `:arweaveHash`. Its API section has the route right.

### Stake-gated uploader door, signed uploads, upload limits (built 2026-10-17)

**The hole.** The backend registers every upload on-chain by itself, and the uploader door only asked "is this wallet the uploader?". So anyone could upload a PDF, never stake, and open "their" book on Alexandria's Lit credit. Each upload also costs the storage wallet its Arweave fee (about $0.06/MiB), paid at mining, **before** any stake. The stake is 100 ALEX (`MIN_STAKE`), a deposit refunded after the 14-day window plus a 50 ALEX reward. So an upload that is never staked is pure cost.

**Owner decisions:**
- **The uploader door requires a stake.**
- **Uploads are limited per wallet:** at most 3 waiting for a stake, plus a 24-hour backstop.
- **Alexandria pays for storage for now (a subsidy), capped by a shared daily budget.** Users pay later. The payment method is still to be chosen (AR, ETH/USDC on Base, or ALEX). ALEX has no market value on testnet, so charging it would recover nothing yet.
- **Book keys are kept in IndexedDB until the access ends** (see R3 above).

| Change | Where | Tests |
|---|---|---|
| Uploader door: `getUploader == reader` **and** `stakes(hash).staker == reader`. The staker record survives `unstake()` and slashing, so approved books stay readable. | Action (`readAccess`); backend `checkReadAccess` (decrypt-params and relay answer `403 stake_required`) | Action 53–55; relay 33b; chainReads (3 new) |
| Signed uploads: an EIP-4361 message, "Upload one book to Alexandria.", naming `urn:alexandria:pdf:sha256:<hex of the exact PDF>`. Checked before any work. A signature authorizes that one file for at most 30 minutes, because it is checked only once the whole file has arrived (unlock messages keep 10). Replaying it can only re-upload the same file, which the SHA-256 dedup rejects. ⚠️ multipart/form-data turns each LF in a text field into CRLF in transit (the HTML standard, measured end to end through multer), so the controller turns CRLF back into LF before verifying. Found in the pre-commit review: without that conversion, every upload from a real browser failed while every test passed. | `services/uploadAuth.service.js`, sharing a strict parser with the unlock message (`services/walletMessage.service.js`); frontend `buildUploadMessage` (`unlockMessage.js`), byte-identical to the backend builder | uploadFlow (9 new); relay 13b |
| Per wallet: at most `UPLOAD_MAX_AWAITING_STAKE` (3) uploads stored or being stored without a stake. Staking frees a slot. Plus at most `UPLOAD_MAX_PER_WALLET_PER_DAY` (10) uploads in any 24 hours. Uploads whose storage failed never count, because they were never paid for. Both rules answer `429` before any work. | `services/uploadQuota.service.js` | uploadFlow (7 new) |
| Shared budget: at most `UPLOAD_DAILY_BUDGET_AR` (default **3 AR**, about $13 at the price recorded in ARWEAVE-DIRECT-PLAN.md) of storage fees in any 24 hours, all wallets together. Checked twice: once early (no room at all), and once exactly, after signing and before sealing. Either way the answer is `503 upload_budget_exhausted` with nothing spent. | same | uploadFlow (4 new) |
| `GET /api/upload/quota/:address`: the waiting uploads (with titles), the 24-hour count, and the budget used. The upload page shows these before the form, disables the button at a limit with the reason, and offers "Stake now →" / "View progress →" for each waiting upload. | `getUploadQuota`; frontend `Upload.jsx` | uploadFlow (3 new) |

All new rules were mutation-checked: 20 planted bugs, each caught by the intended test (one first slipped through and gained test 13b). Every suite passes: Action 55, relay 42, chainReads 99, uploadFlow 84, readPaths 45, securityAndDedup 51, storageWorker 78, arweaveConfig 45.

**Not decided yet:**
- **The budget.** 3 AR a day is a cautious default that still fits one maximum-size upload (about 2 AR). Set `UPLOAD_DAILY_BUDGET_AR` to the real figure. Keep it at least `ARWEAVE_MAX_REWARD_AR`, or large books can never be uploaded.
- **Users paying for storage:** the payment method and the refund-on-approval option are still open.
- **Limitations:**
  - The per-wallet rules stop honest overuse. New wallets get fresh per-wallet allowances, so only the shared budget limits a determined attacker.
  - Two uploads checked at the same instant can both pass, the same race as the wallet balance check.
  - The owner-door branch with a real stake runs only in simulation until step E.

### Still to ask the owner

Nothing blocking. The code is built. The next action is the owner running R6 (`scripts/lit-group-probe.mjs`) and sharing its output; then steps C–E.

### Sources (added 2026-10-17)

- [S8] ERC-1271, https://eips.ethereum.org/EIPS/eip-1271
- [S9] ERC-6492, https://eips.ethereum.org/EIPS/eip-6492 (magic bytes, verification order, `ValidateSigOffchain`)
- [S10] EIP-4361, https://eips.ethereum.org/EIPS/eip-4361 (message format, nonce, RFC 3339 times, domain rule, ERC-1271)
- [S11] KAI, write-up of an ERC-6492 bypass in Coinbase's x402 facilitator, https://kai.dria.co/product-news/coinbase-x402-signature-bypass (not independently verified)
- Live reads and test calls T1–T5 on 2026-10-17. The T1–T5 scripts were kept outside the repo; they used a throwaway key or fixed test bytes only. R6's script is `scripts/lit-group-probe.mjs`.

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
