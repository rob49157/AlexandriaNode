// Rate limits and the credit reserve for POST /api/rental/unlock/:arweaveHash.
//
// Every forwarded unlock is a metered Lit call (~1 cent, measured 2026-10-17), and
// uploads seal keys from the same account balance. So a reader who could unlock in
// a loop could stop uploads as well as reads (KEY-BINDING.md, R4).
//
//   per wallet  keyed on the address RECOVERED from the signature, so one wallet
//               cannot spread its requests across addresses it merely names. Kept
//               well below the hourly ceiling: uploading any PDF makes a wallet an
//               uploader, so a wallet with access is free to obtain, and one wallet
//               must not be able to take every reader's share.
//   global      ceilings on forwarded calls per hour and per day, whoever makes
//               them. The daily one bounds what reads can spend while nobody watches.
//   credit      a reserve the account balance must stay above, so reads can never
//               spend the credit that uploads need to seal keys.
//
// In memory, per process. Enough for the single-server PoC; a restart resets the
// counts, and a second instance would need a shared store.

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * @param {object} [o]
 * @param {number} [o.perWallet]          unlocks per wallet per window
 * @param {number} [o.perWalletWindowMs]
 * @param {number} [o.globalPerHour]      forwarded Lit calls per hour, all wallets
 * @param {number} [o.globalPerDay]       forwarded Lit calls per day, all wallets
 * @param {() => number} [o.now]          ms clock (tests)
 */
function createUnlockLimiter({
  perWallet = 3,
  perWalletWindowMs = 10 * 60_000,
  globalPerHour = 60,
  globalPerDay = 300,
  now = () => Date.now(),
} = {}) {
  const wallets = new Map();
  const lastHour = [];
  const lastDay = [];

  const prune = (list, windowMs, t) => {
    while (list.length && list[0] <= t - windowMs) list.shift();
  };

  const refusal = (list, windowMs, t) => ({
    ok: false,
    retryAfterSeconds: Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)),
  });

  // Keep the map from growing with every wallet that ever asked once.
  const sweep = (t) => {
    if (wallets.size < 1000) return;
    for (const [key, list] of wallets) {
      prune(list, perWalletWindowMs, t);
      if (list.length === 0) wallets.delete(key);
    }
  };

  return {
    /** @param {string} address a recovered (proven) wallet address */
    takeWallet(address) {
      const t = now();
      const key = address.toLowerCase();
      const list = wallets.get(key) || [];
      wallets.set(key, list);
      prune(list, perWalletWindowMs, t);
      if (list.length >= perWallet) return refusal(list, perWalletWindowMs, t);
      list.push(t);
      sweep(t);
      return { ok: true };
    },
    /** Only for a call that is about to be paid for. Takes from both ceilings or neither. */
    takeGlobal() {
      const t = now();
      prune(lastHour, HOUR_MS, t);
      prune(lastDay, DAY_MS, t);
      if (lastHour.length >= globalPerHour) return refusal(lastHour, HOUR_MS, t);
      if (lastDay.length >= globalPerDay) return refusal(lastDay, DAY_MS, t);
      lastHour.push(t);
      lastDay.push(t);
      return { ok: true };
    },
  };
}

/**
 * Stops unlocks while the Lit account's credit is below a reserve, and warns.
 *
 * Fails open when the balance cannot be read: the ceilings above still bound the
 * spend, and an unreadable billing endpoint must not lock every reader out.
 *
 * @param {object} o
 * @param {() => Promise<number>} o.readCreditCents  remaining credit, in cents
 * @param {number} [o.minCreditCents]  0 disables the check
 * @param {number} [o.refreshMs]       how long a reading is trusted
 * @param {() => number} [o.now]
 * @param {(message: string) => void} [o.warn]
 */
function createCreditGuard({
  readCreditCents,
  minCreditCents = 100,
  refreshMs = 5 * 60_000,
  now = () => Date.now(),
  warn = (message) => console.warn(message),
}) {
  let reading = null; // { creditCents: number|null, at: number }

  return {
    /** @returns {Promise<{ ok: boolean, creditCents: number|null }>} */
    async check() {
      if (minCreditCents <= 0) return { ok: true, creditCents: null };

      const t = now();
      if (!reading || t - reading.at >= refreshMs) {
        let creditCents = null;
        try {
          creditCents = await readCreditCents();
          if (creditCents < minCreditCents) {
            warn(
              `[unlock] Lit credit is ${creditCents} cents, below the ${minCreditCents}-cent reserve kept for uploads. ` +
                'Unlocks are paused until the account is topped up.'
            );
          }
        } catch (err) {
          warn(`[unlock] could not read the Lit credit balance (${err.status || 'network'}); not enforcing the reserve`);
        }
        reading = { creditCents, at: t };
      }

      if (reading.creditCents === null) return { ok: true, creditCents: null };
      return { ok: reading.creditCents >= minCreditCents, creditCents: reading.creditCents };
    },
  };
}

function envInt(name, fallback, { allowZero = false } = {}) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isInteger(n) && (n > 0 || (allowZero && n === 0)) ? n : fallback;
}

function limiterFromEnv() {
  return createUnlockLimiter({
    perWallet: envInt('UNLOCK_RATE_PER_WALLET', 3),
    perWalletWindowMs: envInt('UNLOCK_RATE_WINDOW_MINUTES', 10) * 60_000,
    globalPerHour: envInt('UNLOCK_RATE_GLOBAL_PER_HOUR', 60),
    globalPerDay: envInt('UNLOCK_RATE_GLOBAL_PER_DAY', 300),
  });
}

/** @param {() => Promise<number>} readCreditCents */
function creditGuardFromEnv(readCreditCents) {
  return createCreditGuard({
    readCreditCents,
    minCreditCents: envInt('UNLOCK_MIN_CREDIT_CENTS', 100, { allowZero: true }),
  });
}

module.exports = { createUnlockLimiter, createCreditGuard, limiterFromEnv, creditGuardFromEnv };
