-- Direct Arweave L1 storage (ARWEAVE-DIRECT-PLAN.md §4.4). Additive only: every
-- column is nullable or defaulted, so existing rows and the running Irys code path
-- are unaffected. No backfill: legacy rows keep storageProvider = NULL.

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "arweaveAnchorHeight" INTEGER,
ADD COLUMN     "arweaveBlockHeight" INTEGER,
ADD COLUMN     "arweaveConfirmations" INTEGER,
ADD COLUMN     "arweaveReward" TEXT,
ADD COLUMN     "arweaveTxPostedAt" TIMESTAMP(3),
ADD COLUMN     "arweaveUploaderState" JSONB,
ADD COLUMN     "storageAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "storageError" TEXT,
ADD COLUMN     "storageProvider" TEXT;

-- CreateIndex
CREATE INDEX "Upload_status_idx" ON "Upload"("status");

