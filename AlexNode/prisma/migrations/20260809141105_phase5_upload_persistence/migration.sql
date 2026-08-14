/*
  Warnings:

  - Added the required column `encryptionAuthTag` to the `Upload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `encryptionIv` to the `Upload` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "encryptionAuthTag" TEXT NOT NULL,
ADD COLUMN     "encryptionIv" TEXT NOT NULL,
ADD COLUMN     "isNearDuplicate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nearDuplicateOf" TEXT,
ADD COLUMN     "pageCount" INTEGER;
