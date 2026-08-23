-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "arweaveHashTopic" TEXT,
ADD COLUMN     "contract" TEXT NOT NULL,
ADD COLUMN     "logIndex" INTEGER NOT NULL,
ALTER COLUMN "arweaveHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "arweaveHashTopic" TEXT;

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "lastProcessedBlock" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Event_arweaveHash_idx" ON "Event"("arweaveHash");

-- CreateIndex
CREATE INDEX "Event_arweaveHashTopic_idx" ON "Event"("arweaveHashTopic");

-- CreateIndex
CREATE INDEX "Event_blockNumber_idx" ON "Event"("blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Event_transactionHash_logIndex_key" ON "Event"("transactionHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Upload_arweaveHashTopic_key" ON "Upload"("arweaveHashTopic");

