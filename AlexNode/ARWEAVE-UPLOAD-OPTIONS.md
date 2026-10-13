# Ways to get our books onto Arweave without Irys

A companion to [`ARWEAVE-DIRECT.md`](ARWEAVE-DIRECT.md). That file covers how a direct
L1 upload works; this one compares **every route we found** for getting bytes onto
Arweave. Researched 2026-10-10.

Rules are the same as `ARWEAVE-DIRECT.md`. Every claim has a numbered source. **[live]**
means we queried the service ourselves on 2026-10-10 (around 15:30–16:00 UTC), and the
command is shown so you can repeat it. **Inference** marks our own reasoning. Gaps are
listed as gaps.

The criterion the team set: **no intermediary between our signed upload and the Arweave
miners**, because the last one (Irys) is retiring its Arweave path on 1 Nov 2026
(`ARWEAVE-DIRECT.md` §1).

---

## Summary

| # | Option | Who sits between us and Arweave | Cost per GiB (snapshot) | Status | Fits the criterion? |
|---|---|---|---|---|---|
| A | **Direct L1, public nodes** | Nobody (any node relays to miners) | ≈ $57.28 | Protocol, live | ✅ Yes |
| B | **Direct L1, our own node** | Nobody, not even a relay | ≈ $57.28 + server | Protocol, live | ✅ Yes, strongest |
| C | **Self-hosted bundler** (ar.io gateway + Turbo sidecar) | Our own infrastructure | ≈ $57.28 + servers | Documented, live | ✅ Yes, but heavy |
| D | **ArDrive Turbo** (hosted) | ArDrive / ar.io | ≈ $88.27 | Live | ❌ Third party |
| E | **Arseeding** (everVision) | everVision, or self-host | — | Hosted endpoint **suspended** | ❌ Not viable |
| F | **up.arweave.net** (Forward Research) | Forward Research | — | **Unknown** | ❌ Unverifiable |
| G | **Self-bundling** (arbundles → our own L1 tx) | Nobody | ≈ $57.28 | Library only | ✅ Yes, but no gain for us |

The costs come from the live price queries in §A and §D. USD uses AR = $4.13 (CoinGecko,
2026-10-10) [16]. Prices are dynamic, so treat these as a snapshot.

---

## A. Direct L1 transactions via public Arweave nodes

Fully covered in [`ARWEAVE-DIRECT.md`](ARWEAVE-DIRECT.md). Recap:

- We sign an Arweave format-2 transaction with our own JWK and push it with arweave-js
  `getUploader()` (header to `/tx`, then 256 KiB chunks to `/chunk`) [D4][D7].
- The id is `SHA-256(signature)`, known before we pay, so the Lit key binding is
  preserved [D2].
- **[live]** `GET arweave.net/price/1073741824` → `13870417983167` winston = 13.87 AR
  ≈ **$57.28 / GiB**.
- The node we post to only relays. Any of the network's peers will do (`GET /peers`).

**Trade-offs:** we must hold AR, wait for confirmations, handle re-submission, and work
within the 50 MiB pending-chunk default per node (`ARWEAVE-DIRECT.md` §5–6).

---

## B. Direct L1 via our own Arweave node

Option A, but we post to a node we run, so not even the relay is someone else's.

- Arweave docs list a **Validator** node type: validators "share blocks and transactions
  with other nodes" and "typically do not mine" [1]. Every Arweave node is also a
  validator [1].
- The node software is open source, and `bin/start-localnet` is in the same repo
  (`ARWEAVE-DIRECT.md` §10).
- Hardware is covered by a separate "Hardware Guide" [1]. **Gap:** we have not read it,
  so we cannot state server requirements yet.

**Inference:** this is the end state that best matches the criterion, but it is
infrastructure we do not need on day one. Start with A, posting to several public peers
with fallback. Move to B later, and the upload code does not change, only the node URL.

---

## C. Self-hosted bundler: ar.io gateway + Turbo bundler sidecar

The same ANS-104 data-item model we use with Irys today, but we run the bundler.

- The ar.io gateway README: "You can run a Turbo ANS-104 data item bundler as a sidecar
  to the ar.io gateway service … Your gateway will now accept data items at
  `<your gateway url>/bundler/tx`" [2].
- "All uploads of bundled data items to Arweave will be signed and paid for by this
  wallet", meaning our `BUNDLER_ARWEAVE_WALLET` (JWK), which "must maintain a balance of
  AR tokens" [3].
- By default it accepts only data items from `ALLOW_LISTED_ADDRESSES` [2][3]. The docs
  leave `PAYMENT_SERVICE_BASE_URL` empty for that scheme [3].
- The bundler needs the gateway's indexes "synced up to Arweave's current block height
  minus 18 blocks before starting" [2].
- **[source code]** `docker-compose.bundler.yaml` pulls
  `ghcr.io/ardriveapp/turbo-upload-service`, `…-fulfillment` and `…-localstack` images,
  plus `postgres:13.8` [4].
- Gateway hardware, per ar.io docs: minimum 4-core CPU, 4 GB RAM, 500 GB SSD, 50 Mbps;
  recommended 12-core, 32 GB, 2 TB, 1 Gbps [5].
- The gateway (`ar-io/ar-io-node`) is AGPL-3.0 [6].

⚠️ **Gap:** the bundler ships as container images. We found **no public source
repository** for `turbo-upload-service` in the `ardriveapp` or `ar-io` GitHub orgs
(full repo listing checked [6]), so we could not verify its license or audit it.

**What it buys us (Inference):** ids stay ANS-104 data-item ids, signed with any key the
bundler allows, so `controller/arweave.js` changes the least. **What it costs:** a
gateway, Postgres, a LocalStack S3 and two bundler services to operate, all of it to
bundle one book at a time, which is not what bundling is for (see G).

---

## D. ArDrive Turbo (hosted)

The most direct like-for-like replacement for Irys, and still a third party.

- "Turbo is an ar.io gateway run by the ArDrive team" that accepts paid uploads, bundles
  them as ANS-104 and posts them to Arweave [7].
- **[live]** `GET https://upload.ardrive.io/v1/info` →
  `freeUploadLimitBytes: 107520`, free tier `lifetimeBytes: 10485760`, and payment
  addresses for arweave, ethereum, solana and matic.
- Payment uses Turbo Credits, which are "non-refundable and cannot be withdrawn" [8].
  Supported funding includes AR, ETH/USDC on Base and Ethereum, SOL, POL and card [8].
- **[live] Fee.** Every top-up we priced carries a **"Turbo Infrastructure Fee"**:
  `operator: multiply, operatorMagnitude: 0.65`, meaning **35% is kept**. This applied
  to USD, AR, ETH, base-eth and SOL alike:
  ```
  GET https://payment.ardrive.io/v1/price/usd/1000     → adjustmentAmount -350 of 1000
  GET https://payment.ardrive.io/v1/price/arweave/1e12 → winc 650000000000 (of 1 AR)
  ```
- **[live]** Storage itself is priced at L1 cost.
  `GET payment.ardrive.io/v1/price/bytes/1073741824` → `13870385498857` winc, the same
  figure as the L1 `/price` (13870417983167 winston). `GET /v1/rates` →
  **$88.27 per GiB** once the fee is included, against ≈ $57.28 direct.
- SDKs: `@ardrive/turbo-sdk` (Apache-2.0) supports Arweave, Ethereum, Base and Solana
  signers, chunked uploads over 10 MiB, and custom `uploadServiceConfig.url` /
  `paymentServiceConfig.url` [9]. `turbo-upload`, a zero-dependency client, does **not**
  support Ethereum keys [10].

**Inference:** about 54% more expensive than direct, and it is exactly the kind of
dependency we are leaving. It is worth knowing as an **emergency fallback**: because ids
are `sha256(signature)` (ANS-104), switching to it would not change stored ids.

---

## E. Arseeding (everVision / Web3Infra)

- Open-source Go "lightweight arweave data seed node" with a bundle API, Apache-2.0 [11].
  Paid through everPay in AR, ETH, USDC and others [12].
- **[live]** The hosted endpoint used in the docs [12], `https://arseed.web3infra.dev`,
  returns a page titled **「抱歉，站点已暂停」 ("Sorry, the site has been suspended")**.
  API paths return 404.
- **[source code]** `everFinance/arseeding`: last release `v1.2.5` on 2024-02-27, last
  push 2024-10-12 [11].

**Not viable** as a service. Self-hosting means adopting a codebase with no release in
2.5 years.

---

## F. up.arweave.net (Forward Research)

- Announced in Dec 2023, during the Irys fork dispute, as a free, subsidised bundler run
  by Forward Research with ar.io support [13].
- An Irys blog post says it accepts only Arweave-key-signed uploads and AR payment. Irys
  is a competitor, so treat that as biased [14].
- **[live]** Every path we tried (`/`, `/info`, `/tx`, `/bundler`) answers
  `405 Not Allowed` (nginx). The host is up, but we found **no current documentation**
  for it.

**Not usable**: we cannot verify its terms, pricing or longevity, and "free and
subsidised" is the opposite of a durable guarantee.

---

## G. Self-bundling (arbundles → our own L1 transaction)

- ANS-104 libraries let you build a bundle of data items locally and post it as one L1
  transaction. arweave-js recommends `ArBundles` for "large batches" [D4].
- `ar-io/arbundles` was last pushed 2025-04-01 [6]. The original npm `arbundles` package
  is reported as deprecated [15].

**Inference:** bundling saves per-transaction overhead across **many small** items. We
upload **one 150–300 MB book at a time**, so a bundle of one costs L1 price plus
envelope overhead and gains nothing. It only becomes interesting if we batch uploads.

---

## Recommendation

1. **Option A now.** It is the only route that meets the criterion without new
   infrastructure, it is the cheapest, and the 1 Nov deadline is three weeks out.
   Post to a list of public peers with fallback.
2. **Option B later.** Run our own validator node once volume justifies it. This is a
   URL change, not a code change.
3. **Keep D documented, not integrated**, as a break-glass fallback. It costs 35% more,
   and switching never alters stored ids.
4. **Reject E and F.** E's hosted service is suspended; F cannot be verified.
5. **Revisit C or G only if** we start batching many uploads into one transaction.

---

## Open questions

1. **Hardware for an Arweave validator node (B).** Read the official Hardware Guide [1].
2. **The license and source of `turbo-upload-service` (C).** Images only; no public repo
   found.
3. **Whether the Turbo 35% fee applies to every funding path**, including x402
   pay-per-upload. We priced top-ups only.
4. **What up.arweave.net is today (F).**
5. All open questions in `ARWEAVE-DIRECT.md` still apply to A and B.

---

## Sources

Accessed 2026-10-10. `[D#]` refers to the Sources list in `ARWEAVE-DIRECT.md`.

1. Arweave docs, Node Types: https://docs.arweave.org/developers/mining/overview/node-types
2. ar.io gateway README, "Run a Turbo Bundler as a Sidecar": https://github.com/ar-io/ar-io-node#run-a-turbo-bundler-as-a-sidecar
3. ar.io docs, Bundler extension: https://docs.ar.io/build/extensions/bundler/ and https://github.com/ar-io/ar-io-node/blob/main/.env.bundler.example
4. ar.io gateway `docker-compose.bundler.yaml`: https://github.com/ar-io/ar-io-node/blob/main/docker-compose.bundler.yaml
5. ar.io docs, Run a Gateway, Installation & Setup: https://docs.ar.io/build/run-a-gateway/quick-start/
6. GitHub org repo listings (licenses, last-push dates): https://github.com/orgs/ar-io/repositories, https://github.com/orgs/ardriveapp/repositories
7. ar.io docs, Getting Started with Turbo: https://docs.ar.io/build/upload/bundling-services
8. ar.io docs, Paying for Uploads: https://docs.ar.io/build/upload/turbo-credits
9. turbo-sdk: https://github.com/ardriveapp/turbo-sdk
10. turbo-upload: https://github.com/ardriveapp/turbo-upload
11. Arseeding repo and releases: https://github.com/everFinance/arseeding
12. Arweave cookbook, Posting transactions with arseeding.js: https://cookbook.ar.io/guides/posting-transactions/arseeding-js.html
13. Sam Williams (Arweave founder) on X, Dec 2023: https://x.com/samecwilliams/status/1736506715523178571
14. Irys blog, "Comparing Irys SDK to Up" (competitor source): https://irys.xyz/blog/irys-sdk-up-arweave
15. arbundles on npm: https://www.npmjs.com/package/arbundles
16. CoinGecko simple price API, AR/USD: https://api.coingecko.com/api/v3/simple/price?ids=arweave&vs_currencies=usd

Live endpoints queried (repeatable):
- `https://arweave.net/price/{bytes}`
- `https://upload.ardrive.io/v1/info`
- `https://payment.ardrive.io/v1/price/bytes/{bytes}`, `/v1/price/{token}/{amount}`,
  `/v1/price/usd/{cents}`, `/v1/rates`
- `https://arseed.web3infra.dev`
- `https://up.arweave.net/{,info,tx,bundler}`
