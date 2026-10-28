const { ethers } = require('ethers');

const REVIEW_COUNT = 3;
const CONSENSUS_COUNT = 2;
const REVIEW_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const MIN_RATIONALE_LENGTH = 10;
const MAX_RATIONALE_LENGTH = 1000;

function buildChallengeReviewMessage({ arweaveHash, vote, rationale, timestamp }) {
  return [
    'Alexandria Challenge Review',
    'Chain ID: 84532',
    `Book: ${arweaveHash}`,
    `Vote: ${vote}`,
    `Rationale: ${rationale}`,
    `Issued At: ${timestamp}`,
    'This signature records one immutable librarian review; it does not resolve the on-chain challenge.',
  ].join('\n');
}

function verifyChallengeReview({ arweaveHash, vote, rationale, timestamp, signature, librarian }) {
  if (!['uphold', 'dismiss'].includes(vote)) {
    return { ok: false, status: 400, error: 'invalid_vote', message: 'Vote must be uphold or dismiss.' };
  }
  if (typeof rationale !== 'string' || rationale.trim().length < MIN_RATIONALE_LENGTH || rationale.trim().length > MAX_RATIONALE_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_rationale',
      message: `Rationale must be between ${MIN_RATIONALE_LENGTH} and ${MAX_RATIONALE_LENGTH} characters.`,
    };
  }
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > REVIEW_SIGNATURE_WINDOW_MS) {
    return { ok: false, status: 401, error: 'review_signature_expired', message: 'Request a fresh signature and try again.' };
  }
  if (typeof signature !== 'string' || !ethers.isAddress(librarian || '')) {
    return { ok: false, status: 400, error: 'invalid_signature', message: 'A valid librarian address and wallet signature are required.' };
  }

  const cleanRationale = rationale.trim();
  const message = buildChallengeReviewMessage({ arweaveHash, vote, rationale: cleanRationale, timestamp });
  let signer;
  try {
    signer = ethers.verifyMessage(message, signature);
  } catch {
    return { ok: false, status: 401, error: 'invalid_signature', message: 'The review signature could not be verified.' };
  }
  if (signer.toLowerCase() !== librarian.toLowerCase()) {
    return { ok: false, status: 401, error: 'review_signer_mismatch', message: 'The connected wallet did not sign this review.' };
  }

  return { ok: true, librarian: signer.toLowerCase(), vote, rationale: cleanRationale, message, signature };
}

function summarizeReviews(reviews) {
  const countedReviews = reviews.slice(0, REVIEW_COUNT);
  const summary = {
    submitted: countedReviews.length,
    required: REVIEW_COUNT,
    consensus: null,
    votes: null,
  };
  if (countedReviews.length < REVIEW_COUNT) return summary;

  const uphold = countedReviews.filter((review) => review.vote === 'uphold').length;
  const dismiss = countedReviews.length - uphold;
  summary.votes = { uphold, dismiss };
  summary.consensus = uphold >= CONSENSUS_COUNT ? 'uphold' : 'dismiss';
  return summary;
}

function isStoredChallengeReviewValid(review) {
  if (!review || !review.arweaveHash || !review.librarian || !review.vote || !review.rationale || !review.signedMessage || !review.signature) {
    return false;
  }
  const timestampMatch = review.signedMessage.match(/^Issued At: (\d+)$/m);
  if (!timestampMatch) return false;
  const expected = buildChallengeReviewMessage({
    arweaveHash: review.arweaveHash,
    vote: review.vote,
    rationale: review.rationale,
    timestamp: Number(timestampMatch[1]),
  });
  if (expected !== review.signedMessage) return false;
  try {
    return ethers.verifyMessage(review.signedMessage, review.signature).toLowerCase() === review.librarian.toLowerCase();
  } catch {
    return false;
  }
}

module.exports = {
  REVIEW_COUNT,
  CONSENSUS_COUNT,
  MIN_RATIONALE_LENGTH,
  MAX_RATIONALE_LENGTH,
  buildChallengeReviewMessage,
  verifyChallengeReview,
  summarizeReviews,
  isStoredChallengeReviewValid,
};