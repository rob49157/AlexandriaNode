-- CreateTable
CREATE TABLE "Upload" (
    "arweaveHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "uploader" TEXT NOT NULL,
    "uploadTimestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "sha256Hash" TEXT NOT NULL,
    "simHash" TEXT NOT NULL,
    "litEncryptedKeyId" TEXT NOT NULL,
    "onChainTxHash" TEXT,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("arweaveHash")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" SERIAL NOT NULL,
    "eventName" TEXT NOT NULL,
    "arweaveHash" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Upload_sha256Hash_key" ON "Upload"("sha256Hash");

-- CreateIndex
CREATE INDEX "Upload_title_author_idx" ON "Upload"("title", "author");
