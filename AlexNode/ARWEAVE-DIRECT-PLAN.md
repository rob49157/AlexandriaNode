# Option A — implementation plan: direct Arweave L1 uploads

The build plan for [`ARWEAVE-UPLOAD-OPTIONS.md`](ARWEAVE-UPLOAD-OPTIONS.md) option A
(direct L1 transactions through public Arweave nodes), designed so that option B (our
own node) is later a **URL change only**. Protocol facts come from
[`ARWEAVE-DIRECT.md`](ARWEAVE-DIRECT.md), whose source numbers are cited here as
`[D#]`. New facts verified for this plan are marked **[source code]** and listed at
the bottom. Written 2026-10-10.

---

## 1. The short version

Today one HTTP request does everything, and Irys answers instantly:

```
validate → encrypt → sign → seal → push (instant receipt) → Postgres → registerUpload → 201
```

Arweave L1 has no instant receipt, so the flow splits in two. The **request** does the
cheap, fast part. A **storage worker** finishes it over the next minutes:

```
REQUEST   validate → encrypt → sign → seal → POST header → spool ciphertext → Postgres → 202
                                                                    status: pending_confirmation
WORKER    header mined? → upload chunks (resumable) → N confirmations → delete spool
                                                                    status: pending_stake
          → registerUpload()                                        status: pending
```

The Lit envelope, the key binding, the event listener, rentals, staking and search are
all untouched. The arweaveHash is still a 43-character base64url `sha256(signature)`
[D2].

---

## 2. Four design problems the Irys path never had, and how this plan answers them

### 2.1 A dropped transaction cannot be re-sealed

If a header is never mined, the transaction has to be re-signed, which gives it a new id.
Our Lit envelope seals the **old** id, and by then the symmetric key has been zeroed, as
CLAUDE.md requires. So a dropped transaction cannot be repaired. The book has to be
uploaded again.

**[source code]** Nodes accept two kinds of anchor [S1][S2]:

| Anchor | Expires? | Parallel uploads? |
|---|---|---|
| **Block anchor** (`GET /tx_anchor`, used by arweave-js by default [S3]) | Yes, after 50 blocks (≈ 100 min) [D8][D9] | Unlimited |
| **Wallet anchor** (`last_tx` = the wallet's last outgoing tx id) | No; valid until the wallet sends another tx | **One at a time.** A tx anchored to a tx still in the mempool is rejected `last_tx_in_mempool` [S1] |

**Recommendation:** use block anchors and treat a drop as a clean failure:
- After 50 blocks with no confirmation, the worker marks the row `storage_failed` and
  frees its `sha256Hash`, so the archivist's re-upload is not rejected as a duplicate.
- **Inference:** a fee is only deducted when a transaction is mined, so a drop costs
  time, not money. Phase 0 verifies this.
- The key-zeroing rule stays exactly as it is.

The alternative is wallet anchors, which make drops near-impossible but serialise every
upload behind the previous confirmation (≈ 2–10 min each). That is a reasonable choice
at low volume. **This is decision D1** (§8).

### 2.2 The ciphertext must outlive the request

Once a header is mined, its fee is paid, but the data arrives separately as chunks.
**[source code]** arweave-js posts the header alone, then chunks, whenever the data is
more than one 256 KiB chunk [S4]. Resuming needs "the same data as the original
upload" [D4]. Today the ciphertext lives only in request memory. A crash between header
and last chunk would leave a **paid-for transaction with no data that we can never
complete**.

**Fix:** write the ciphertext to a spool directory (`ARWEAVE_SPOOL_DIR`) before posting
the header, and delete it only after the data is confirmed. This is compatible with
CLAUDE.md's rules, which forbid **plaintext** PDFs and raw keys on disk. The ciphertext
is what we are about to publish permanently anyway.

### 2.3 The 50 MiB pending-chunk limit

Nodes hold at most 50 MiB of chunks per **pending** transaction by default [D2], and a
book is 150–300 MB.

**Fix:** post the header, **wait until it is mined**, then upload the chunks. The limit
is on pending transactions, and arweave-js supports uploading data to an already-mined
transaction [D4]. Splitting the work this way also matches §2.2: the worker resumes
from saved uploader state, `getUploader(savedState, data)` [D4].

### 2.4 A large book can't be read with one request

A node serves `/tx/{id}/data` only up to 12 MiB [D11]. That affects the read path only
(§4.7).

---

## 3. Status lifecycle

```
                         ┌──── header not mined in 50 blocks ───► storage_failed
                         │                                         (sha256 freed; re-upload)
pending_confirmation ────┤
 (header posted)         └── mined → chunks uploaded → N confs ──► pending_stake ──► pending ──► …
                                                                     (today's flow resumes here)
```

`pending_stake` keeps its current meaning, "bytes stored, not yet registered", so
`stake.controller.js`, `eventListener.service.js` and the librarian queue need no logic
change. What changes is that a row now reaches it later.

---

## 4. File-by-file

### 4.1 New: `config/arweave.js` (replaces `config/irys.js`)
- An `Arweave` client per node URL from `ARWEAVE_NODE_URLS` (comma list, failover,
  the same pattern as `BASE_TESTNET_RPC_URL`). Option B = put our node first in the list.
- Load the JWK from `ARWEAVE_WALLET_FILE`. Derive the address with
  `wallets.jwkToAddress()` [D4] and assert it against `ARWEAVE_WALLET_ADDRESS`. This
  keeps the guard from `validateWalletKey()` that already caught a wrong key.
- `getBalance()` via `wallets.getBalance(addr)` [S5]; `getPrice(bytes)` via `/price` [D2].
- Export `ARWEAVE_GATEWAY_URLS`, `ARWEAVE_CONFIRMATIONS`, `ARWEAVE_SPOOL_DIR`.

### 4.2 Rewrite: `controller/arweave.js`
| Function | Today | New |
|---|---|---|
| `prepareUpload(ciphertext, tags)` | Irys `createTransaction` + `sign` | `arweave.createTransaction({data})` (fetches anchor + price [S3]), `addTag` × n, `transactions.sign(tx, jwk)`. Returns `{ arweaveHash: tx.id, tx }`. |
| `commitUpload(tx, hash)` | Irys `tx.upload()` + receipt check | **Split in two.** `postHeader(tx, data)`: `getUploader` + one `uploadChunk()`, which posts the header only [S4]; returns serialised uploader state. `uploadChunks(state, data)`: worker-side resume loop. |
| `fetchEncrypted(hash)` | `gateway.irys.xyz` | Gateway list with fallback (§4.7) |
| `buildTags` | 200-char cap per value | Keep, plus a **byte-total assertion** against Arweave's 2048-byte tag limit [D2] |
| `transactionId`, `sameTransactionId`, base58 helpers | Irys base58/base64url trap | `tx.id` is already base64url [D2]. Keep `isValidArweaveHash` and `sameTransactionId`; the base58 path may become dead code, and Phase 0 decides. |

### 4.3 Edit: `controller/upload.controller.js` (`createUpload`)
- `sign` → `seal` order unchanged.
- **New:** spool the ciphertext, then `postHeader()`. A failure is 502 with nothing paid,
  because an unmined header costs nothing (Inference, verified in Phase 0).
- Create the row as `status: 'pending_confirmation'` with the new storage columns (§4.4).
- **Remove** the inline `registerOnChain` call; the worker makes it after confirmation.
- Response `202 Accepted` with `status: 'pending_confirmation'` and
  `nextStep: 'Storage confirming on Arweave; poll GET /api/upload/:arweaveHash'`.
  ⚠️ This is a **response contract change for the frontend repo** (§6).
- Replace the `irys_unavailable` reason with `arweave_unavailable`, and update the comments
  that say "Irys".

`retryRegistration` gets one guard: refuse with `409 storage_not_confirmed` unless the
row is `pending_stake`. Registering an unconfirmed transaction would let an archivist
stake on bytes the network may still drop.

### 4.4 Edit: `prisma/schema.prisma` + migration
New nullable columns on `Upload`:
```prisma
storageProvider      String?   // "arweave-l1" | "irys-devnet" (legacy rows)
arweaveTxPostedAt    DateTime?
arweaveAnchorHeight  Int?      // height of the ANCHOR block (not of signing) → drop deadline = this + 50
arweaveBlockHeight   Int?      // height it was mined in
arweaveConfirmations Int?
arweaveUploaderState Json?     // serialised getUploader() state, no data [D4]
arweaveReward        String?   // winston, exact fee from the signed header (D7)
storageError         String?
storageAttempts      Int       @default(0)
@@index([status])               // the worker polls by status
```
`sha256Hash @unique` stays. On `storage_failed` the worker moves it aside (for example
`failed:<hash>:<ts>`) so a re-upload passes dedup. **Inference:** this is simpler than
making the unique index partial.

**Also (code review, 2026-10-11):** the SimHash near-duplicate lookup in
`services/dedup.service.js` must exclude `status = 'storage_failed'` rows. Otherwise
every re-upload of a failed book is flagged as a near-duplicate of a row that has no
bytes. Phase 4 adds this, together with a test.

### 4.5 New: `services/storage.service.js` (the worker)
Same shape as `eventListener.service.js`: `start()`/`stop()`, a poll interval,
`getStatus()` for a health route. Each tick, for every `pending_confirmation` row:

1. `transactions.getStatus(id)` [D4].
2. **Not mined** and anchor height + 50 has passed → `storage_failed`, delete spool,
   free sha256.
3. **Mined, chunks outstanding** → load spool + uploader state → `uploadChunk()` loop,
   saving state after each chunk so a crash resumes [D4].
4. **Chunks done and confirmations ≥ N** → (optional, Phase 0 decides) spot-check
   retrievability → delete spool → `pending_stake` → `registerOnChain()` (existing
   service, unchanged) → `pending` on success.

It must survive restarts. All state lives in Postgres plus the spool, never in memory.

### 4.6 Edit: `index.js`
Start and stop the storage worker next to the event listener, with
`STORAGE_WORKER_ENABLED` mirroring `EVENT_LISTENER_ENABLED`.

### 4.7 Read path: `fetchEncrypted`, and the frontend
- `ARWEAVE_GATEWAY_URLS`, comma list, fallback in order.
- Large books can't come from a plain node (12 MiB cap [D11]), so the list has to
  contain gateways. **Inference:** reading is not a trust dependency, because the
  ciphertext is verified by AES-GCM's auth tag on decrypt. A gateway can withhold data
  but cannot forge it.

### 4.8 New route: `GET /api/storage/status`
Wallet address, AR balance, rows per storage status, the oldest pending age, and the
last worker error. 503 when the worker is stopped. This follows the reasoning behind
`/api/chain/status`: "the worker died" must not look like "nobody uploaded".

### 4.9 Small edits
| File | Change |
|---|---|
| `controller/search.controller.js` | Add `pending_confirmation`, `storage_failed` to `SEARCH_STATUSES` |
| `controller/litProtocol.js` | Comment-only: "Irys data item" → "Arweave transaction" |
| `services/securityScan.service.js` | Comment-only |
| `config/blockchain.js` | Comment-only (mentions the Irys wallet) |
| `.env.example` | Remove `IRYS_*`; add `ARWEAVE_WALLET_FILE`, `ARWEAVE_WALLET_ADDRESS`, `ARWEAVE_NODE_URLS`, `ARWEAVE_GATEWAY_URLS`, `ARWEAVE_CONFIRMATIONS`, `ARWEAVE_SPOOL_DIR`, `STORAGE_WORKER_ENABLED`, `STORAGE_POLL_INTERVAL_MS` |
| `.gitignore` | The JWK file and the spool dir |
| `package.json` | Remove `@irys/upload`, `@irys/upload-ethereum`; `arweave` `^1.15.7` → `^2.1.0`; add `"engines": {"node": ">=22"}` (§8 D4) |

### 4.10 Scripts
| File | Change |
|---|---|
| `scripts/irys-setup.js` | → `scripts/arweave-wallet-setup.js`: generate a JWK [D4], write it to `ARWEAVE_WALLET_FILE`, print the address and balance. **Never** print the key. |
| `scripts/smoke-test.js` | Real L1 run: a small fixture, post, wait for confirmation, fetch back, decrypt. ⚠️ Real AR, permanent (§7). |
| `scripts/verify-upload.js` | Read from the gateway list; also print `/tx/{id}/status` confirmations |

### 4.11 Tests
| File | Change |
|---|---|
| `tests/uploadFlow.test.js` | Replace the fake Irys with a fake arweave-js. ⚠️ Build the fake from **Phase 0's real responses**, not from this doc. That is the lesson of the base58 incident in `ARWEAVE-IRYS.md`. Assert a 202, `pending_confirmation`, no inline registration, the spool file written, and no spend on a Lit failure. |
| **New** `tests/storageWorker.test.js` | Not mined → wait; past deadline → `storage_failed` + sha256 freed; mined → chunks; crash mid-chunks → resume from saved state; confirmed → `pending_stake` → registration called once; registration failure stays `pending_stake`. |
| `tests/readPaths.test.js`, `tests/chainReads.test.js` | Swap the `../config/irys` stub for `../config/arweave` |
| `tests/keyBinding.demo.js`, `tests/encryption.manual.js` | No logic change; comments |

### 4.12 Docs
- **CLAUDE.md**: the upload flow (steps 9–14), the env block, the security rules (the
  "two keys" paragraph becomes `ARWEAVE_WALLET_FILE` + `BACKEND_PRIVATE_KEY`), the
  "Irys Wallet Funding Model" (now an AR wallet), the project tree, the status list, and
  the roadmap Phase 1 (archivist-funded storage would mean archivists paying in AR).
- `ARWEAVE-IRYS.md`: a banner saying "Retired 2026-11-01, see ARWEAVE-DIRECT.md", kept
  for history and the encoding incident.
- `KEY-BINDING.md`: one line noting the binding is unchanged under L1.

---

## 5. What does NOT change

`litProtocol.js` logic · `KEY-BINDING.md` guarantees · `registration.service.js` ·
`eventListener.service.js` · `blockchain.service.js` · rental / stake / librarian
controllers · validation, security scan, dedup · `abis/` · contracts.

---

## 6. Outside this repo

- **AlexandriaFrontEnd**: handle `202` + `pending_confirmation`, poll
  `GET /api/upload/:hash` until `pending_stake`/`pending`, and only then offer
  approve/stake. Its reads must use the gateway list (§4.7). The decryption Lit Action,
  if built, is unaffected.
- **Treasury**: buy AR and fund the storage wallet (`ARWEAVE-UPLOAD-OPTIONS.md` §A).
- **Existing rows**: all current books are on Irys **devnet**, which "does not reach
  Arweave" and expires after ~60 days (`ARWEAVE-IRYS.md`). There is nothing to migrate.
  Mark them `storageProvider: 'irys-devnet'`.

---

## 7. Phases

| Phase | What | Exit criterion |
|---|---|---|
| **0. Spike** | A throwaway script on **mainnet** with a funded JWK and test fixtures only (never a real book). (a) 1 MiB upload. (b) ~60 MiB upload: header first, wait for mining, then chunks. Record real responses. | All §9 "verify in Phase 0" items answered. Responses saved as test fixtures. |
| **1. Wallet + config** ✅ 2026-10-11 | `config/arweave.js`, `scripts/arweave-wallet-setup.js`, `.env.example`, Node 22, deps. Not yet on the request path. | Balance shows; address assertion works. **Met:** live `status` against mainnet nodes; `tests/arweaveConfig.test.js` 24/24 |
| **2. Storage layer** | `controller/arweave.js` rewrite, spool | Unit tests against the Phase 0 fixtures |
| **3. Schema + request path** | Migration ✅ 2026-10-11 (`20261011120000_arweave_l1_storage_fields`, applied to Neon; `SEARCH_STATUSES` extended). Still to do: `createUpload` → 202 | `uploadFlow.test.js` green |
| **4. Worker** | `storage.service.js`, `index.js`, status route, registration gating | `storageWorker.test.js` green |
| **5. Live** | Smoke test end to end on mainnet with a small fixture | Upload → confirmed → registered on Base Sepolia → fetched → decrypted |
| **6. Cleanup** | Remove Irys deps/files, docs | `grep -ri irys` hits only history docs |

⚠️ **There is no testnet** (`ARWEAVE-DIRECT.md` §10). Phases 0 and 5 spend real AR and
publish permanently. The data is ciphertext of test fixtures, so it is harmless but
public forever. At today's price, 1 MiB costs ≈ 0.0135 AR ≈ $0.06, and 60 MiB about
$3.40 (from the `/price` snapshot in `ARWEAVE-UPLOAD-OPTIONS.md`).

---

## 8. Decisions — **decided 2026-10-10** (team accepted the recommendations)

| # | Decision | Outcome |
|---|---|---|
| D1 | Anchor type | **Block anchor** (arweave-js default via `GET /tx_anchor`). A drop becomes `storage_failed` and the archivist re-uploads. |
| D2 | Confirmations before `pending_stake` | **`ARWEAVE_CONFIRMATIONS`, default 15** (ArDrive's choice [D10]; revisit with Phase 0 timings) |
| D3 | JWK storage | **File path**, `ARWEAVE_WALLET_FILE` (default `.arweave-wallet.json`, gitignored) |
| D4 | Runtime | **Node 22 + arweave-js 2.1.0.** Done: `package.json` `arweave ^2.1.0`, `engines.node >=22`, `.nvmrc` = `22.21.1` |
| D5 | Dev spending | **Real AR, test fixtures only.** The spike refuses any fee above `SPIKE_MAX_AR` (default 1 AR) and only ever uploads random bytes tagged `App-Name=Alexandria-Spike`. |
| D6 | Where uploads are posted (decided 2026-10-11) | **Raw peer nodes, not a gateway.** `arweave.net` is a gateway in front of the network, not a single node. Phase 0 posts headers and chunks to raw peers taken from `GET /peers` and checked with `GET /info`. Gateways are used only to read data back and check it. |
| D7 | Who pays for storage (decided 2026-10-11) | **For now, the treasury pays (model C), and every row records `arweaveReward`.** The fee is paid once, at upload: *"an upfront contribution, denominated in AR"* [D17]. It is fixed once signed, because `reward` is part of the signed header (`transaction.js`). Later options, to decide using the real per-book costs: **A**, the archivist pays at upload (needs a contract change and an AR→$ALEX rate; $ALEX has no market price on testnet); **B**, rentals pay it back (`setBookPrice` exists; how `processRentalPayment` splits payments is unverified). Unverified: whether the protocol's difficulty-based AR-per-byte price [D17] keeps the fiat cost stable. |

---

## 8b. Phase 0 runbook (`scripts/arweave-spike.js`)

```bash
nvm use 22.21.1
node scripts/arweave-spike.js wallet          # creates .arweave-wallet.json, prints the address
#   → back up the file, fund the address with ~3 AR (total of the runs below ≈ 2.86 AR at 2026-10-11 prices), set ARWEAVE_WALLET_ADDRESS in .env
node scripts/arweave-spike.js sign-test       # free: Q1 id checks, sends nothing
node scripts/arweave-spike.js small --yes                              # ≈0.0135 AR
node scripts/arweave-spike.js small --reward-multiplier 1.1 --yes      # ≈0.0149 AR, Q7
node scripts/arweave-spike.js large --mb 150 --max-ar 2.1 --yes        # ≈2.02 AR, worst case: our max size, header first → Q2, Q3
node scripts/arweave-spike.js large --mb 60 --eager --yes              # ≈0.81 AR, worst case: chunks BEFORE mining → expected 50 MiB limit (Q3)
node scripts/arweave-spike.js watch <txId>    # per run: mined → chunks → 15 confs → read probes
node scripts/arweave-spike.js status <txId>   # later: re-probe gateways (Q6)
node scripts/arweave-spike.js report          # Q1–Q9 evidence table
```

Run `quote --mb 150` first: AR prices move, and the totals above are a 2026-10-11 snapshot.
Both large runs were chosen on 2026-10-11 to test the worst cases. The eager run does not
fail over between nodes before mining, so the 50 MiB limit is measured, not hidden.
`watch` finishes its chunks after mining. Every run's raw node responses are saved in
`.arweave-spike/<txId>/run.json`; these become Phase 2's test fixtures.

Nodes (D6): `selectNodes()` reads `GET /peers` from `ARWEAVE_PEER_SEEDS` (default
`https://arweave.net`, used **only** to learn addresses), checks each candidate with
`GET /info` (network `arweave.N.1`, within 2 blocks of the best height), and puts one node
per /24 address block first. Setting `ARWEAVE_NODE_URLS` skips discovery (our own node,
Option B). Observed 2026-10-11: 27–40 of 60 probed peers healthy; peers speak plain HTTP,
which is acceptable because the header is signed and the data is ciphertext.

Already answered for free (2026-10-10, `sign-test` on a throwaway wallet): the id after
`sign()` is 43-character base64url, equals `base64url(sha256(signature))`, and
`transactions.verify()` accepts it. Still to confirm on a live post: that the node
reports the same id.

---

## 8c. Code review fixes (2026-10-11)

Peers are unauthenticated and speak plain HTTP, so `config/arweave.js` no longer
trusts any single one of them:
- **Tip height is the median** of healthy peers when there are **3 or more**, not the
  max. Under the old rule, one peer claiming height 10¹² evicted every honest node. A
  height that is missing or not an integer makes the node unhealthy, rather than
  producing NaN and caching an empty list.
- **Price is the median of up to 3 quotes** (asked in parallel), and is refused above
  `ARWEAVE_MAX_REWARD_AR` (default 3 AR, must be > 0). With 3 quotes, one inflated
  quote cannot overpay and one deflated quote cannot shrink the reward into a drop.
- **With fewer than 3 values, the highest wins** (`robustAgg`), for both heights and
  prices. Two values cannot say which one is wrong, so the cheaper failure is picked.
  A second check reproduced the lower median picking the wrong one in both cases:
  pinned `[ours@950, public@1000]` kept only the lagging node, which serves anchors that
  are already expiring; quotes `[1, 13530674461]` gave a fee of 1 winston, which can
  never be mined. An inflated price is bounded by the cap. A single pinned node gives
  one value, and for prices the cap is then the only guard.
- `ARWEAVE_CONFIRMATIONS` / `ARWEAVE_MAX_REWARD_AR` are validated and fail loudly at
  load, as one line in the scripts rather than a stack trace.
- **The drop deadline counts from the anchor block**, not from signing. The tx is valid
  while its anchor is among the last 50 blocks [D2]. Live, 2026-10-11: `/tx_anchor` on 3
  nodes returned a block **5 behind the tip** (tip 2019454, anchor 2019449), so "signed
  at + 50" overstated the window by ~10 min. The spike records the anchor height
  (`GET /block/hash/{anchor}`) and calls a drop 3 blocks after the deadline (lag
  margin). `arweaveAnchorHeight` in the schema holds the anchor block's height.
- `scripts/arweave-spike.js` now uses `config/arweave.js` for the wallet, nodes,
  balance and price, so Phase 0 measures production code rather than a copy. Commands
  share the module's cached node list, so one discovery serves the whole command and
  the price comes from the nodes we post to.
- `SEARCH_STATUSES` was reverted: the storage-worker states are not catalogue states.

**Known, accepted for now:** in `package-lock.json`, Irys's nested `arweave@1.15.7` is
now `optional: true, peer: true`. A normal `npm install` / `npm ci` installs it. Only
`--omit=optional` would drop it and break the Irys upload path. This goes away with
Irys in Phase 6. Do not deploy with `--omit=optional` before then.

---

## 9. Verify in Phase 0 (not assumed)

1. Is `tx.id` after `sign()` the same base64url string nodes and gateways report? (Is
   the base58 helper dead?)
2. Does the first `uploadChunk()` on a multi-chunk transaction post only the header?
   Source says yes [S4]; confirm against a live node.
3. Does uploading chunks **after** mining avoid the 50 MiB pending limit as expected?
4. Is the wallet charged only when the header is mined (no charge for a dropped tx)?
5. Real timings: post → mined, mined → N confirmations, chunk throughput.
6. How long before a gateway serves the data, and which gateways serve > 12 MiB?
7. Is a reward above `/price` accepted? (A margin against congestion drops.)
8. Do 3 independent nodes all accept the same signed header, and what does a node return
   for a header it already has? Does re-sending an unmined header (`watch`, every 5 blocks
   while the node answers 404) ever get it mined?
9. When chunk upload fails over to a second node mid-transaction, does it accept the rest?
10. *(Not measured by the script yet.)* How long do nodes keep accepting chunks for a mined
    transaction whose data has not arrived? This bounds how long a crashed worker has to resume.
11. How far behind the tip does `/tx_anchor` pick its block, and does it vary? One live
    snapshot (2026-10-11, 3 nodes) said 5 blocks. Every run records `anchorHeight`, and
    `report` prints the gap. The Phase 4 worker's deadline uses the anchor height.

---

## Sources (new in this plan)

`[D#]` = `ARWEAVE-DIRECT.md` Sources. All accessed 2026-10-10.

- **S1** Arweave node `ar_tx_replay_pool.erl` (`verify_anchor`, `last_tx_in_mempool`, `verify_block_anchor`): https://github.com/ArweaveTeam/arweave/blob/master/apps/arweave/src/ar_tx_replay_pool.erl
- **S2** Arweave node `ar_tx.erl` (`check_last_tx`: valid when it equals the wallet's last tx): https://github.com/ArweaveTeam/arweave/blob/master/apps/arweave/src/ar_tx.erl
- **S3** arweave-js `common.ts` (`createTransaction` fetches `getTransactionAnchor()` and `getPrice()` when not supplied): https://github.com/ArweaveTeam/arweave-js/blob/master/src/common/common.ts
- **S4** arweave-js `transaction-uploader.ts` (`postTransaction`: data in body only when ≤ 1 chunk, otherwise "Post the transaction with no data"; 100 errors × ~40 s before giving up): https://github.com/ArweaveTeam/arweave-js/blob/master/src/common/lib/transaction-uploader.ts
- **S5** arweave-js README, `wallets.getBalance`: https://github.com/ArweaveTeam/arweave-js
