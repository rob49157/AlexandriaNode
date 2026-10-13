# Uploading to Arweave directly (no Irys)

Research for replacing `config/irys.js` with direct Arweave L1 transactions.
Researched 2026-10-10.

**How to read this file.** Every factual claim has a numbered source in
[Sources](#sources). Claims tagged **[source code]** were read from the Arweave node or
arweave-js source on GitHub, which is the strongest evidence we have. Anything that is
our own reasoning, rather than something a source states, is tagged **Inference**.
Things we could not confirm are listed in [Open questions](#open-questions), not
guessed at.

---

## 1. Why this is no longer optional

Irys's migration page says [1]:

> `node1.irys.xyz` and `mainnet.arweave.irys.xyz` send uploads to Arweave … will be
> retired on **1 November 2026**.
>
> `uploader.irys.xyz` sends new uploads to Irys L1 mainnet.
>
> Switching to the Irys L1 endpoint changes the destination for new uploads.
>
> If your application requires future uploads to remain on Arweave, choose and validate
> an Arweave-compatible upload path before the retirement date.

That is **three weeks from today**. Staying on Irys after that date means our books go
to Irys L1, not Arweave. `ARWEAVE-IRYS.md` (deleted 2026-10-13; in git history) already explains why that
is unacceptable for Alexandria: permanence on a multi-miner protocol is the product.

The same page also says [1]:

> An SDK migration does not move historical data between networks.

What the page **does not** say: anything about Irys **devnet**, which is what we use
today, or about `gateway.irys.xyz`, which is where `fetchEncrypted()` reads from. See
[Open questions](#open-questions).

This is the second time Irys's direction has diverged from Arweave's. In 2023 Irys
proposed forking Arweave [12][13]. It is the concrete reason for the decision this
document supports: **no intermediary between us and the Arweave network**.

---

## 2. What "directly" means

An Arweave L1 transaction, signed with our own Arweave wallet and posted to Arweave
nodes. No bundler, no ANS-104 data item, no Irys balance.

| Field | Meaning | Source |
|---|---|---|
| `format` | Must be `2`. Format 1 is no longer accepted. | [2][4][5] |
| `id` | "A SHA-256 hash of the transaction signature." | [2] |
| `last_tx` | Anti-replay anchor: a hash of one of the last 50 blocks, or the last outgoing tx id. Get it from `GET /tx_anchor`. | [2] |
| `owner` | RSA modulus `n` of the JWK. Empty for ECDSA. | [2] |
| `tags` | Name/value pairs. Total size limit applies (see §6). | [2] |
| `data_root`, `data_size` | Merkle root and size of the data (format 2). | [2] |
| `reward` | The fee, in winston. | [2] |
| `signature` | RSA-PSS for RSA keys; a 65-byte recoverable signature for ECDSA. | [2][3] |

---

## 3. The key binding survives, and the ordering still works

This was the question that mattered most, because [`KEY-BINDING.md`](KEY-BINDING.md)
depends on knowing the `arweaveHash` **before** paying anything.

Verified facts:

- A transaction id is `SHA-256(signature)` [2]. This is the same construction as the
  Irys data item ids we use now.
- arweave-js: "a transaction ID can't be known until its contents are finalised and it
  has been signed", and `transaction.id` is set by `arweave.transactions.sign()` [4].
- Signing is a local operation on the JWK. `sign()` takes the key, and the HTTP calls
  are `post`, `getUploader` and `uploadChunk` [4].
- Changing a transaction after signing invalidates the signature [4].

**Inference:** our order of operations carries over unchanged:

```
AES encrypt            local
createTransaction      needs: anchor (GET /tx_anchor) + fee (GET /price/{bytes})
addTag … sign          local, free  ──►  arweaveHash = tx.id is now final
sealKey(arweaveHash)   Lit — a failure here still costs nothing
upload (post + chunks) $$, permanent
```

`prepareUpload` / `commitUpload` in `controller/arweave.js` keep their shape. Only
their insides change.

**New constraint the Irys path did not have (Inference from [2] + §5).** The anchor is
only valid for 50 blocks, about 100 minutes at the 120 s target. If the header is not
accepted in that window, the transaction must be rebuilt with a fresh anchor. That means
a new signature, so a **new id**, so the Lit envelope (which seals the old id) must be
**re-sealed**. Re-sealing is cheap. The rule that matters: never write the id to
Postgres or call `registerUpload()` until the id is final **and confirmed** (§7).

---

## 4. Wallet

Two key types are accepted on Arweave today.

### RSA (the mainstream path)

- 4096-bit RSA keys in JWK format, public exponent 65537, signatures are RSA-PSS with
  SHA-256 [2].
- Generate with `arweave.wallets.generate()`; derive the address with
  `arweave.wallets.jwkToAddress(key)` [4].
- arweave-js warns that keys "can never be recovered if lost" [4].

### ECDSA secp256k1 (exists, but tooling lags)

- Activated at the 2.9 hard fork [3].
- Format 2 only, empty `owner`, 65-byte compact recoverable signature [3].
- The address is the SHA-256 of the public key, **not** an Ethereum address. Arweave docs
  warn: "If you transfer AR to an Ethereum address on Arweave, you will lose the
  funds." [3]
- arweave-js support is "currently available" only on a `master-ec` branch, published
  under the npm tag `ec` [3]. **[source code]** That tag is `2.0.0-ec.2`, published
  2025-03-04, which is behind `latest` (`2.1.0`, 2026-09-08) [6].

**Inference:** use RSA. ECDSA would only save the overhead of a 4096-bit key, and it
puts us on a side branch that is 18 months behind the main release. Our separation rule
stays as it is: this is a **third** key (`ARWEAVE_WALLET_KEY`), distinct from
`BACKEND_PRIVATE_KEY`. It pays for storage and does nothing else.

---

## 5. Upload mechanics for 150–300 MB books

### Chunked, resumable upload

arweave-js recommends `getUploader()` for data transactions because it allows "larger
transaction sizes" and resuming [4]:

```js
let uploader = await arweave.transactions.getUploader(transaction);
while (!uploader.isComplete) {
  await uploader.uploadChunk();
}
```

- **Resume:** serialise with `JSON.stringify(uploader)`, then call
  `getUploader(savedObject, data)`. "You must provide the same data as the original
  upload." The serialised state does not include the data [4].
- **[source code]** The uploader posts the transaction header to `/tx` first, then each
  chunk to `/chunk`. It treats `data_root_not_found` as retryable ("we may have hit a
  node that just hasn't seen it yet"), and waits 40 s after an error
  (`ERROR_DELAY = 1000 * 40`) [7].
- `post()` is for "small transactions or token transfers" [4].

### Limits

| Limit | Value | Source |
|---|---|---|
| Chunk size | 256 KiB (`DATA_CHUNK_SIZE`) | [2], **[source code]** [8] |
| Pending chunks per (data_root, data_size) on a node | 50 MiB (node default, configurable) | [2] |
| All pending chunks on a node | 2 GiB (node default, configurable) | [2] |
| Inline `data` field in the request body | 12 MiB on all nodes at time of writing | [2] |
| Tags | 2048 bytes for names + values combined [2]; `MAX_TX_TAGS = 2048` in source [8] | [2][8] |
| Anchor depth | 50 blocks (`STORE_BLOCKS_BEHIND_CURRENT`, returned by `get_max_tx_anchor_depth()`) | **[source code]** [8][9] |
| Target block time | 120 s (`TARGET_BLOCK_TIME`) | **[source code]** [8] |

⚠️ **The 50 MiB pending-chunk limit matters for us.** A 150 MB book is larger than one
node's default pending-chunk allowance for a single transaction, until the header is
mined [2]. **Inference:** either wait for the header to confirm before pushing most of
the chunks, or spread chunks across several nodes. We have not confirmed how
arweave-js behaves when it hits this limit; see Open questions.

### Our tags fit

`buildTags()` writes IV, auth tag, metadata, uploader and sha256. **Inference:** these
total well under 2048 bytes, but `buildTags()` should assert the byte total so that a
long title cannot push a transaction over the limit.

---

## 6. Confirmation, not receipt

This is the biggest behavioural change. Irys returned a signed receipt instantly. L1
returns `200` on post, and arweave-js is explicit: "This `200` response does not mean
that the transaction has mined & confirmed" [4].

- Check with `arweave.transactions.getStatus(id)`. It returns `block_height`,
  `block_indep_hash` and `number_of_confirmations`. arweave-js "strongly advise[s]" checking
  status and confirmations before relying on an id [4]. Node endpoint:
  `GET /tx/{id}/status` [2].
- Block time is typically 2–3 minutes [10]; the protocol target is 120 s [8].
- A transaction can come back **Not Found** if its reward was too low for it to be mined
  within 50 blocks during congestion, or if it was dropped during fork recovery [10].
- ArDrive waits for **15 confirmations** before treating an upload as final [10]. That
  is one operator's policy, not a protocol rule.

**Inference, design consequences:**

1. New status: `pending_confirmation` before `pending_stake`.
2. Call `registerUpload()` only after N confirmations. Otherwise an archivist could stake
   on a book whose bytes the network then dropped.
3. A background job re-checks pending transactions. While the anchor is still valid
   (50 blocks), it can re-post the **same** signed header, which keeps the same id. After
   that, the transaction cannot be repaired: re-signing gives a new id, and the key that
   could re-seal it was zeroed at upload. The row becomes `storage_failed` and the
   archivist re-uploads (`ARWEAVE-DIRECT-PLAN.md` §2.1, decision D1).

---

## 7. Reading data back

**[source code]** A node serves `GET /tx/{id}/data` only up to `MAX_SERVED_TX_DATA_SIZE`
= **12 MiB**, unless the operator enabled `serve_tx_data_without_limits`. Above that it
returns `400 tx_data_too_big` [11].

**Inference:** every real book is above 12 MiB. So either:

- read chunk by chunk with `GET /chunk/{offset}` (the endpoint exists [11]), or
- read through a gateway.

`arweave.net` is a gateway, not "Arweave itself", and its operator changes: "On March 1,
2026, ar.io transitioned operation of the arweave.net gateway back to the Forward Research
team", a handoff that "introduced some (temporary) instability" [15]. Today `fetchEncrypted()` reads from `gateway.irys.xyz`,
which is also a third party.

**Inference:** gateways are a convenience, not a dependency, because the bytes stay on
the miners whichever gateway serves them. But the read path should take a **list** of
gateways and fall back across it, the same pattern we already use for
`BASE_TESTNET_RPC_URL`.

---

## 8. Cost (live snapshot, 2026-10-10 15:32 UTC)

Queried directly from `arweave.net`. The response header `Arweave-Denomination: 1`
confirms the units [5].

| Size | `GET /price/{bytes}` (winston) | AR | USD at $4.13/AR [16] |
|---|---|---|---|
| 150 MiB (157,286,400 B) | 2,031,834,901,235 | 2.032 | ≈ $8.39 |
| 1 GiB (1,073,741,824 B) | 13,870,417,983,167 | 13.870 | ≈ $57.28 |

1 AR = 10¹² winston. The node reported height 2,018,575 and 217 peers.

What the fee buys, per the official docs: "Users pay for 200 years' worth of
replicated storage at present prices", and the endowment is sustainable indefinitely at
a 0.5% annual decline in storage cost, against a historical average of about 38.5% per
year [17]. The fee is split between the mining miner and the endowment [17]. There is an
extra fee for the first transaction to a new wallet [2][17].

Prices are dynamic and underpriced transactions are rejected [2]. **Re-query `/price`
for every upload; never hard-code these numbers.**

---

## 9. Funding: we must hold AR

Fees are denominated in AR [17]. There is no Base-ETH payment option without a bundler.
AR is listed on several major exchanges (sources name Kraken, OKX, Binance, KuCoin and
others), subject to country availability and KYC [18][19]. We have not checked
availability for the project's jurisdiction.

The Irys funding model in CLAUDE.md carries over unchanged. The treasury stays offline
and tops up a lightly funded storage wallet, which now holds AR.

---

## 10. Testing without spending AR

- **arlocal:** `npx arlocal` serves a fake gateway on `:1984`, with `/mint/<addr>/<bal>`
  and `/mine` [20]. ⚠️ The repository was "archived by the owner on May 15, 2025. It is
  now read-only." [20] Its README does not mention format-2 chunk uploads.
- **Official localnet:** **[source code]** The Arweave node repo contains
  `bin/start-localnet` (which runs `arweave localnet`), `bin/create-wallet`,
  `bin/create-ecdsa-wallet` and a `localnet_snapshot/` directory [21]. We found no
  written documentation for it.
- We found no source describing a public Arweave testnet comparable to Irys devnet.
  The repo has a `testnet/` scripts directory [21], but nothing says it is public.

⚠️ Remember the lesson in `ARWEAVE-IRYS.md` (deleted 2026-10-13; in git history): a mock certifies your assumptions.
**Inference:** before mainnet, do at least one small real L1 upload on mainnet. Under
the 12 MiB serve limit costs cents. Do not rely on arlocal, which is archived and may
pre-date format-2 chunking.

---

## 11. Library and runtime

**[source code]** arweave-js releases [6]:

- `v2.0.1` (2026-09-01): "Requires **Node ≥ 22**". Malformed base64 now throws.
- `v2.1.0` (2026-09-08): format 1 creation and signing now throw.
- The previous major line ended at `1.15.x`.

Our `package.json` pins `arweave@^1.15.7`, and this machine runs **Node v20.19.0**.
CLAUDE.md says "Node.js v18+". **Inference:** moving to arweave-js 2.x means moving the
backend to Node 22, which is worth doing anyway, since [6] notes Node 20 reached EOL in
April 2026.

---

## 12. What remains third-party, honestly

Going direct removes the bundler. It does not remove every outside party:

| Dependency | Replaceable? |
|---|---|
| The node you POST to | Yes. Any of the network's peers (`GET /peers` [11]), or run our own node. |
| The gateway you read from | Yes. Use a list with fallback, or read chunks from nodes (§7). |
| An exchange to buy AR | Any exchange that lists AR [18][19]. |
| arweave-js | Maintained by ArweaveTeam; the protocol is documented in the HTTP API [2]. |
| Lit, Base RPC | Unchanged by this decision. |

None of these sit between our signed transaction and the miners. That is the property
we lost with Irys.

---

## 13. What changes in this repo (Inference, not yet done)

| File | Change |
|---|---|
| `config/irys.js` → `config/arweave.js` | JWK wallet, node and gateway lists, balance via `GET /wallet/{addr}/balance` |
| `controller/arweave.js` | `prepareUpload`: anchor + price, `createTransaction`, tags, `sign`. `commitUpload`: `getUploader` loop and persisted resume state. `fetchEncrypted`: gateway list, or chunk reads above 12 MiB. `sameTransactionId` stays; ids are already base64url (43 chars) [2]. |
| `prisma/schema.prisma` | `pending_confirmation` status, confirmation count, uploader resume state |
| New job | Confirmation watcher and re-submit |
| `services/registration.service.js` | Register only after N confirmations |
| `package.json` / Node | `arweave@^2.1.0`, Node ≥ 22 |
| Remove | `@irys/upload`, `@irys/upload-ethereum`, `IRYS_*` env |
| `ARWEAVE-IRYS.md` (deleted 2026-10-13; in git history), CLAUDE.md | Mark the Irys path as retired, link here |

---

## Open questions

Things we could **not** verify, and so must not assume:

1. **Irys devnet and `gateway.irys.xyz` after 1 Nov 2026.** The migration page does not
   mention either [1]. Ask Irys, or assume both may stop working.
2. **How arweave-js handles the 50 MiB pending-chunk limit** for a 150–300 MB
   transaction. Test this on a real node before building around it.
3. **The number of confirmations to require.** 15 is ArDrive's choice [10]. We have no
   protocol source for a number.
4. **Replica count** behind the 200-year promise. Secondary sources say about 20; we
   found no official page stating it.
5. **Official localnet usage.** It exists in source [21]; we found no documentation.
6. **AR purchase in our jurisdiction.** Not checked.
7. **Whether the Arweave HTTP API docs [2] are current on signatures.** They describe
   RSA-PSS and also mention ECDSA. The ECDSA page [3] is newer.

---

## Sources

Accessed 2026-10-10.

1. Irys, "Migrating to the Irys L1 bundler SDK": https://docs.irys.xyz/onchain-storage/migrating
2. Arweave docs, HTTP API: https://docs.arweave.org/developers/arweave-node-server/http-api
3. Arweave docs, ECDSA Keys: https://docs.arweave.org/developers/development/overview/ecdsa-keys
4. arweave-js README: https://github.com/ArweaveTeam/arweave-js
5. Arweave node releases (N.2.9.6 format-1 termination; `arweave-denomination` header): https://github.com/ArweaveTeam/arweave/releases
6. arweave-js releases (v2.0.1, v2.1.0) and npm dist-tags: https://github.com/ArweaveTeam/arweave-js/releases, https://registry.npmjs.org/arweave
7. arweave-js uploader source: https://github.com/ArweaveTeam/arweave-js/blob/master/src/common/lib/transaction-uploader.ts
8. Arweave node constants `ar.hrl` (`TARGET_BLOCK_TIME`, `DATA_CHUNK_SIZE`, `MAX_TX_TAGS`, `STORE_BLOCKS_BEHIND_CURRENT`): https://github.com/ArweaveTeam/arweave/blob/master/apps/arweave/include/ar.hrl
9. Arweave node `ar_block.erl` (`get_max_tx_anchor_depth`): https://github.com/ArweaveTeam/arweave/blob/master/apps/arweave/src/ar_block.erl
10. ar.io / ArDrive docs, monitoring transactions: https://docs.ar.io/sdks/ardrive-cli/monitoring-transactions/
11. Arweave node HTTP handler and data-sync source (`serve_tx_data`, `MAX_SERVED_TX_DATA_SIZE`): https://github.com/ArweaveTeam/arweave/blob/master/apps/arweave/src/ar_http_iface_middleware.erl, https://github.com/ArweaveTeam/arweave/blob/master/apps/arweave/include/ar_data_sync.hrl
12. Cointelegraph, "Unofficial Arweave forking plans draw community controversy": https://cointelegraph.com/news/unofficial-arweave-forking-plans-draw-community-controversy
13. Sam Williams (Arweave founder) on X: https://x.com/samecwilliams/status/1736506715523178571
14. *(removed: a claim about 2022 custody of arweave.net could not be confirmed on its cited page)*
15. ar.io, "arweave dot net": https://ar.io/articles/arweave-dot-net/
16. CoinGecko simple price API, AR/USD queried 2026-10-10: https://api.coingecko.com/api/v3/simple/price?ids=arweave&vs_currencies=usd
17. Arweave docs, development overview (endowment, fees): https://docs.arweave.org/developers/development/overview
18. Finder, how to buy Arweave: https://www.finder.com/cryptocurrency/coins/how-to-buy-arweave
19. CoinCodex, how to buy Arweave: https://coincodex.com/how-to-buy-arweave/
20. arlocal repository: https://github.com/textury/arlocal
21. Arweave node repository tree (`bin/`, `localnet_snapshot/`, `testnet/`, `papers/yellow_paper.pdf`): https://github.com/ArweaveTeam/arweave
