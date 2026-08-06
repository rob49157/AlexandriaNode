-- Banded LSH columns for SimHash near-duplicate lookup.
--
-- Each column holds one 16-bit slice of the 64-bit simHash fingerprint,
-- most-significant first. Near-duplicate search matches "any band equal"
-- against these indexed columns instead of scanning every row; by the
-- pigeonhole principle that is a lossless prefilter for Hamming distance <= 3.

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "simHashBand0" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "simHashBand1" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "simHashBand2" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "simHashBand3" INTEGER NOT NULL DEFAULT 0;

-- Backfill the bands from each row's existing simHash.
-- Hex -> integer conversion goes through bit(32): each 4-hex-char band is
-- left-padded to 8 hex chars so the cast width is exact. Values stay in
-- [0, 65535], so the signed INTEGER target never overflows.
-- Rows whose simHash is malformed are left at 0 and are simply invisible to
-- the prefilter rather than breaking the migration.
UPDATE "Upload"
SET "simHashBand0" = ('x0000' || substring("simHash" FROM 1 FOR 4))::bit(32)::int,
    "simHashBand1" = ('x0000' || substring("simHash" FROM 5 FOR 4))::bit(32)::int,
    "simHashBand2" = ('x0000' || substring("simHash" FROM 9 FOR 4))::bit(32)::int,
    "simHashBand3" = ('x0000' || substring("simHash" FROM 13 FOR 4))::bit(32)::int
WHERE "simHash" ~ '^[0-9a-fA-F]{16}$';

-- CreateIndex
CREATE INDEX "Upload_simHashBand0_idx" ON "Upload"("simHashBand0");

-- CreateIndex
CREATE INDEX "Upload_simHashBand1_idx" ON "Upload"("simHashBand1");

-- CreateIndex
CREATE INDEX "Upload_simHashBand2_idx" ON "Upload"("simHashBand2");

-- CreateIndex
CREATE INDEX "Upload_simHashBand3_idx" ON "Upload"("simHashBand3");
