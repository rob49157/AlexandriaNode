# Arweave, Irys, and where the `arweaveHash` comes from

Reference for anyone touching `controller/arweave.js` or `config/irys.js`.

Every claim here is verified against a real Alexandria upload —
`FQ4e7Gt6AB4fSj65bxiyNqrn3Yn2T4nn3dJKKD7ZCx0`, the Phase 5 smoke-test book — and the
commands to re-derive them yourself are included.

---

## The short answer

**Arweave and Irys are two different companies running two different systems, in one
pipeline.** Arweave is the permanent storage network. Irys is an on-ramp that sits in
front of it, batching many small uploads into single Arweave transactions and letting
you pay in ordinary tokens instead of AR.

Alexandria talks only to Irys. Irys talks to Arweave.

```
Alexandria backend  ──►  Irys (bundler)  ──►  Arweave (permanent storage)
                          ▲                     ▲
                    we pay in Base ETH     pays in AR, stores forever
                    instant receipt        the thing that actually persists
```

The `arweaveHash` we store, seal into the Lit envelope, and register on-chain is the
**data item id**: `sha256` of the item's signature, 32 raw bytes, known *before* upload.

---

## Two services, one pipeline

| | **Arweave** | **Irys** |
|---|---|---|
| What it is | Permanent-storage blockchain, live since 2018 | Bundler / upload service in front of Arweave (formerly **Bundlr Network**) |
| Run by | The Arweave protocol + its miners | Irys, a separate company |
| Pay with | AR (its native token) | ETH, Base ETH, MATIC, SOL, and others — see `/info` |
| Payment model | Pay once, stored ~200 years via a storage endowment | Prepaid credit balance you top up |
| Speed | Block times in minutes | Instant signed receipt |
| Good at | Permanence | Throughput, small files, familiar tokens |
| Our config | — | `config/irys.js` |

They are **not** competitors and not the same organisation. Irys is a convenience layer;
Arweave is the thing that actually keeps the bytes.

### ⚠️ Irys has become its own L1, and the Arweave path is deprecated

This changed after the design in CLAUDE.md was written, and it matters strategically.

Irys started as Bundlr (2021), a pure Arweave bundler. It has since launched **its own
Layer 1 "programmable datachain"** — storage plus native smart-contract execution,
advertised at roughly 20× cheaper than Arweave. Irys now recommends migrating to it.

Worth knowing the history, because it explains why the two roadmaps diverged: in 2023
Irys proposed **forking Arweave** (including a token-supply reset). It was contentious,
the fork did not go ahead in the form proposed, and Irys built a separate chain instead.
Not disqualifying — but it tells you these are two independent projects with independent
incentives, not one ecosystem with a shared plan.

Where that leaves us:

| | Status |
|---|---|
| `@irys/upload` → Arweave bundler (**what we use**) | **Deprecated but still operating.** Irys says the bundlers and Arweave gateway "will continue to operate as normal" for users not ready to migrate, but they are "no longer actively supported." |
| `@irys/sdk` (the older package) | Deprecated/EOL — we already avoid it |
| Irys L1 datachain | Actively developed; where Irys is pushing everyone |

So our uploads still land on Arweave and are still permanent on mainnet. But the code
path is on a deprecation track: expect no new features, and treat security fixes as
uncertain.

**The decision to stay on Arweave is deliberate** — see the reasoning below. This is a
risk to monitor, not a bug to fix.

### Why Alexandria stays on Arweave

Alexandria's product promise is permanence and censorship-resistance — outliving the
institutions that would suppress a book. That makes the storage choice a mission
question, not a cost question:

- **Arweave is a protocol with many independent miners.** Irys L1 is one company's chain,
  recently launched. For a library meant to outlive governments, depending on a single
  company's chain for permanence is a category error.
- **Failure modes differ enormously.** If Irys the company disappears while we bundle to
  Arweave, we lose an *on-ramp* — the books are already on Arweave and stay there. If we
  stored on Irys L1 and Irys disappeared, we would lose the books.
- **Arweave's endowment model has ~8 years of operation** behind its pay-once-store-~200-years
  claim. Any replacement needs an equally credible story, and a young chain cannot have
  one yet, however good the engineering.

The honest counter-argument: Irys L1 is ~20× cheaper, and cost is a real constraint for
Alexandria specifically, because archival scans run 150–300 MB. If storage cost ever
becomes the thing blocking real books, revisit this — but revisit it against the
permanence guarantee, not just the invoice.

### The hedge we already have, for free

**Data items are bundler-agnostic.** ANS-104 is a standard, and the id is
`sha256(signature)` — computed locally from our own key, not assigned by Irys. So:

- Switching to another Arweave bundler (e.g. **ArDrive Turbo**) changes nothing about
  ids, the key binding, or anything already stored.
- `config/irys.js` is the only swap point. `controller/arweave.js` is written against
  data items, not against Irys.

If Irys ever stops operating the Arweave bundlers, that is a config-layer migration, not
an architectural one. Worth preserving that property in any future refactor.

### The decision, and what to do about it

**Decided 2026-08-25: stay on Arweave via the Irys bundler.** Not inertia — the
reasoning above. Recorded here so it is a decision with a rationale rather than an
assumption nobody revisits.

Actions, in order:

1. **Nothing now.** It works and is verified end to end. Permanence isn't exercised until
   mainnet anyway, so there is nothing to gain from switching during a PoC.
2. **Track the deprecation as a live risk**, not a settled matter. The specific thing to
   watch is whether Irys keeps operating the Arweave bundlers and gateway.
3. **Before flipping `IRYS_NETWORK=mainnet`**, re-check that the bundlers still run, and
   price **ArDrive Turbo** as the fallback. Mainnet is the point of no return — every
   byte becomes permanent and paid-for — so the storage provider should be a conscious
   choice at that moment, not a leftover from the PoC.
4. **Revisit properly at Deferred Phase 1** (archivist-funded storage). Once archivists
   upload directly from the browser and pay for their own storage, they are the ones
   choosing a provider and absorbing the cost. That is the natural decision point, and it
   will come with real cost data instead of estimates.

**Reopen this decision if** storage cost becomes the thing blocking real books. Archival
scans run 150–300 MB, and a 20× difference is not trivial at volume. Weigh it against
the permanence guarantee, not just the invoice — but weigh it honestly.

### Sources and verification status

Irys's docs site is a JavaScript app, so the claims about the L1 and the bundler
deprecation come from search results and secondary sources rather than a rendered
primary page. **Verify before acting on any of it**, particularly before a mainnet
migration:

- [Irys networks](https://docs.irys.xyz/build/d/networks) — mainnet/devnet, retention, tokens
- [Migrating to the Irys L1](https://docs.irys.xyz/build/d/migrating) — the deprecation and migration path
- [`@irys/sdk` on npm](https://www.npmjs.com/package/@irys/sdk) — carries the deprecation notice
- [Irys L1 launch coverage](https://cryptobriefing.com/irys-launch-layer-1-programmatic-datachain/)
- [2023 Arweave fork proposal](https://www.coinlive.com/news/controversy-arises-as-irys-proposes-arweave-fork-and-token-supply)
- [Lit Protocol's Irys integration notes](https://developer.litprotocol.com/integrations/storage/irys) — relevant to us specifically, since we use both

### Why we don't upload to Arweave directly

Three reasons, all practical:

1. **You'd need AR tokens.** The treasury would have to acquire and hold a fairly
   illiquid asset purely to pay for storage. Irys lets us pay in Base ETH — the same
   token we already hold for gas.
2. **Small files are inefficient.** One Arweave transaction per book means paying
   per-transaction overhead on every upload. Irys bundles thousands of data items into
   one Arweave transaction (the **ANS-104** standard), so we share that cost.
3. **You'd wait for block confirmation.** Irys returns a signed receipt immediately,
   which matters because the upload endpoint is in a user's request path.

---

## ⚠️ On devnet, nothing reaches Arweave

This is the single most misunderstood thing about the current setup.

```
IRYS_NETWORK=devnet     ← where we are now
```

| | devnet | mainnet |
|---|---|---|
| Paid with | free testnet tokens (Base Sepolia ETH) | real Base ETH |
| Reaches Arweave? | **No** | Yes |
| Retention | **~60 days on Irys nodes, then gone** | Permanent |
| Reversible? | It expires on its own | Never |

**The smoke-test book is not permanent and never was.** It lives on Irys devnet nodes
and will disappear on its own. That is the correct state for a PoC — it means test
uploads cost nothing and clean themselves up.

Flipping `IRYS_NETWORK=mainnet` changes the meaning of every upload: real money, real
permanence, no delete. Do not flip it to "see if it works."

---

## The data item

We don't upload a raw file. We upload an **ANS-104 data item** — a signed envelope
wrapping the bytes:

```
┌─ data item ─────────────────────────────┐
│ signature type   3 = Ethereum secp256k1 │
│ owner            public key             │
│ target, anchor   (unused here)          │
│ tags             Content-Type, App-Name,│
│                  Encryption-IV, ...     │
│ data             the AES-GCM ciphertext │
│ signature        ← id is derived from this
└─────────────────────────────────────────┘
```

Real numbers from our book:

```
data_size  346    the ciphertext
raw_size   910    the whole signed envelope
fee        1326672831135 wei of base-eth  (~0.0000013 ETH)
```

Note the overhead: **564 bytes of envelope around 346 bytes of content.** Signature,
public key, and tags are near-constant, so tiny files are proportionally expensive.
Irrelevant for real books (megabytes), but it explains why a test fixture's cost looks
strange. (Irys also doesn't charge at all under 100 KiB, so small fixtures upload free.)

Our tags are set in `buildTags()` and include the AES-GCM IV and auth tag — deliberately
public, because they are useless without the key that only a Lit Action can release.

---

## Where the ID comes from

```
        the ciphertext + tags
                 │
                 ▼
        deep hash of the item
                 │
                 ▼   sign with the Irys wallet key   ← local, offline, free
            signature
                 │
                 ▼   sha256
        32 raw bytes  ←  THIS is the identity
                 │
                 ▼   render as text
        base64url (43 chars)  ← canonical: gateways, tags, our DB, on-chain
        base58    (44 chars)  ← what several Irys APIs hand back
```

### Proving it, on the real book

```js
const crypto = require('crypto');
const tx = await (await fetch('https://devnet.irys.xyz/tx/FQ4e7Gt6AB4fSj65bxiyNqrn3Yn2T4nn3dJKKD7ZCx0')).json();
const sig = Buffer.from(tx.signature.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
crypto.createHash('sha256').update(sig).digest()
  .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
// → 'FQ4e7Gt6AB4fSj65bxiyNqrn3Yn2T4nn3dJKKD7ZCx0'
```

The id **is** `sha256(signature)`. Not assigned by Irys, not assigned by Arweave.

### Why that matters enormously to Alexandria

Because the id is derived from the signature, and signing is local and free, **the
arweaveHash is fully known before a single byte is uploaded or a single cent spent.**

That is what makes the whole key-binding design possible:

```
validate            4xx, nothing spent
AES encrypt         local
sign the data item  local, free  ──►  arweaveHash now known
seal the key        bound to that hash — a Lit failure here still costs nothing
push the bytes      $$, permanent, irreversible
persist + register
```

If the id were assigned by the network at upload time, we would have to upload first and
seal afterwards — and a Lit failure would strand permanently paid-for bytes that nobody
could ever decrypt. See **[`KEY-BINDING.md`](KEY-BINDING.md)**.

`commitUpload`'s receipt check is therefore **not** how we learn the id. It is a
verification that Irys stored the item under the id we already derived.

---

## The encoding trap

The same 32 bytes render into two very different strings:

| Encoding | Length | Alphabet | Example |
|---|---|---|---|
| **base64url** | 43 | `A–Z a–z 0–9 - _` | `FQ4e7Gt6AB4fSj65bxiyNqrn3Yn2T4nn3dJKKD7ZCx0` |
| **base58** | 44 | `A–Z a–z 0–9` minus `0 O I l`; no `-` or `_` | `2RC3uiyDeaSjSmRyJ7HJztyiBWX3RFRhvS922PVnDT6c` |

Both decode to `150e1eec6b7a001e1f4a3eb96f18b236aae7dd89f64f89e7ddd24a283ed90b1d`. Same
book. Neither string contains a hint that the other exists.

### Which surface speaks which

| Surface | Encoding |
|---|---|
| `gateway.irys.xyz/<id>` | base64url |
| Arweave tags, on-chain `registerUpload`, our Postgres | base64url |
| `tx.rawId` → `transactionId()` | *raw bytes* → we render base64url |
| `DataItem.id` getter (`@irys/bundles`) | **base58** |
| Upload receipt `receipt.id` | **base58** |
| `devnet.irys.xyz/tx/<id>` response `.id` | **base58** |

`@irys/bundles` even disagrees with itself: `get id` encodes base58 while `set id`
decodes base64url.

### The rules

1. **Derive, never read.** Always compute the hash as base64url of `tx.rawId`. Never use
   `tx.id`. `transactionId()` does this.
2. **Never compare ids as strings.** Use `sameTransactionId()`, which decodes both sides
   to 32 bytes and compares those.
3. **base64url is canonical.** Anything stored, served, or written on-chain uses it.
   `isValidArweaveHash()` deliberately rejects the 44-char base58 form, so a base58 id
   can never leak into the database or a URL.

### The incident this is written from

`commitUpload` compared `receipt.id` (base58) against our derived hash (base64url) with
`!==`. Those are never equal, so the guard fired on **every upload, including correct
ones** — and it fired *after* the bytes were pushed and paid for, returning a 502 saying
*"Nothing was persisted — please retry."* The bytes were persisted. Retrying paid again.

Four test suites and 226 assertions missed it, because the fake Irys in
`uploadFlow.test.js` returned its receipt id as base64url — faithfully implementing what
CLAUDE.md documented at the time. The doc was wrong about receipts, the production code
inherited the error, and the mock certified it. It survived until the first live upload.

> A mock is only as correct as your understanding of the thing it replaces. Where that
> understanding is wrong, mocks don't merely fail to catch the bug — they certify it.

---

## Quick reference

```bash
# What is this book, across all four systems?
node scripts/verify-upload.js <arweaveHash>

# Fetch the stored ciphertext
curl https://gateway.irys.xyz/<arweaveHash>

# Irys's own record (note: .id comes back base58)
curl https://devnet.irys.xyz/tx/<arweaveHash>

# Storage credit + supported tokens
curl "https://devnet.irys.xyz/account/balance/base-eth?address=<IRYS_WALLET_ADDRESS>"
curl https://devnet.irys.xyz/info

# Prove the whole path: upload → gateway → decrypt (no chain writes)
node scripts/smoke-test.js
```

| Term | Meaning |
|---|---|
| **Arweave** | Permanent storage blockchain. Pay once, stored ~200 years. |
| **Irys** | Bundler in front of Arweave, formerly Bundlr. What we actually call. |
| **ANS-104** | The bundled-data-item standard. What we upload. |
| **data item** | One signed upload inside a bundle. Our book. |
| **`arweaveHash`** | The data item id: `sha256(signature)`, 32 bytes, base64url. |
| **node balance** | Prepaid Irys credit. Distinct from the wallet's on-chain ETH. |
| **devnet** | Free, testnet-token Irys. **Does not reach Arweave.** ~60-day retention. |

Irys's own docs are the authority on pricing, token support, and retention, and those
change: <https://docs.irys.xyz>.
