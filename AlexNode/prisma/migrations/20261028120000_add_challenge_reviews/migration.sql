CREATE TABLE "ChallengeReview" (
    "id" SERIAL NOT NULL,
    "arweaveHash" TEXT NOT NULL,
    "librarian" TEXT NOT NULL,
    "vote" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "signedMessage" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChallengeReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChallengeReview_arweaveHash_librarian_key"
ON "ChallengeReview"("arweaveHash", "librarian");

CREATE INDEX "ChallengeReview_arweaveHash_idx"
ON "ChallengeReview"("arweaveHash");