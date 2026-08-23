// Stake status — live on-chain read, joined against the Postgres index.
//
// Two different questions get answered together because the frontend always
// needs both: "what does the chain say about this stake" (AlexandriaStake) and
// "does our index agree" (Upload.status). A disagreement is a listener lag or a
// sync bug, and surfacing it is more useful than silently preferring one.

const prisma = require('../config/db');
const { isValidArweaveHash } = require('./arweave');
const { getStakeStatus, getUploadOnChain } = require('../services/blockchain.service');
const { handleChainError } = require('./rental.controller');

// GET /api/stake/status/:arweaveHash
async function getStakeStatusForHash(req, res, next) {
  const { arweaveHash } = req.params;

  if (!isValidArweaveHash(arweaveHash)) {
    return res.status(400).json({
      error: 'invalid_hash',
      message: 'arweaveHash must be a 43-character base64url transaction ID.',
    });
  }

  try {
    const [stake, onChain, row] = await Promise.all([
      getStakeStatus(arweaveHash),
      getUploadOnChain(arweaveHash),
      prisma.upload.findUnique({
        where: { arweaveHash },
        select: { status: true, uploader: true, title: true },
      }),
    ]);

    // The book exists nowhere we can see it. 404 rather than an empty stake,
    // which would imply the book is real and merely unstaked.
    if (!onChain.registered && !row) {
      return res.status(404).json({
        error: 'not_found',
        message: `No upload indexed or registered for ${arweaveHash}.`,
      });
    }

    // AlexandriaLibrary is the authority on status; it is what stake.sol and
    // rent.sol both read. "pending_stake" only exists off-chain — it means the
    // bytes are on Arweave but registerUpload() has not been called yet.
    const status = onChain.registered ? onChain.status : 'pending_stake';

    return res.json({
      arweaveHash,
      status,
      registered: onChain.registered,
      uploader: onChain.uploader ?? row?.uploader ?? null,
      title: row?.title ?? null,

      staked: stake.staked,
      stakeActive: stake.active,
      staker: stake.staker ?? null,
      stakeAmount: stake.stakeAmount ?? null,
      stakeAmountAlex: stake.stakeAmountAlex ?? null,
      stakeTime: stake.stakeTime ?? null,
      challengePeriodEnds: stake.challengePeriodEnds ?? null,
      challengePeriodOver: stake.challengePeriodOver ?? null,
      challenge: stake.challenge,

      index: {
        status: row?.status ?? null,
        // True when the event listener has not yet applied the on-chain status.
        // Expected briefly after a transaction; persistent drift is a bug.
        inSync: row ? row.status === status : null,
      },
    });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

module.exports = { getStakeStatusForHash };
