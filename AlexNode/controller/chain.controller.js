// Event listener observability.
//
// The listener is a background loop whose only visible output is a status
// column changing some time after a transaction. Without this endpoint, "the
// listener died four hours ago" and "nobody has staked anything today" look
// exactly the same from the outside.

const { getSyncStatus } = require('../services/eventListener.service');
const { handleChainError } = require('./rental.controller');

// GET /api/chain/status
async function getChainStatus(req, res, next) {
  try {
    const status = await getSyncStatus();

    // A stalled or errored listener is a degraded service, not a healthy one —
    // report it as 503 so a monitor notices without having to parse the body.
    const degraded = Boolean(status.lastError) || !status.running;

    return res.status(degraded ? 503 : 200).json(status);
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

module.exports = { getChainStatus };
