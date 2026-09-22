-- Audit fields for the librarian review queue.
--
-- The queue used to show a single invented score per book. These columns are
-- the facts the pipeline already established at upload time but discarded:
-- how close the near-duplicate match was, whether the virus scanner was
-- actually running, and how much text the book has for any content check to
-- read at all.
--
-- All nullable: rows written before this migration keep their history, and the
-- API reports them as "not recorded" rather than inventing a value. Only
-- nearDuplicateDistance can be reconstructed — the fingerprints are still in
-- the table, while the text counts would need the plaintext PDF, which is
-- encrypted on Arweave and cannot be read back here.

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "nearDuplicateDistance" INTEGER,
ADD COLUMN     "clamavStatus" TEXT,
ADD COLUMN     "textWordCount" INTEGER,
ADD COLUMN     "textlessPageCount" INTEGER;

-- Backfill the distance for rows already flagged as near-duplicates.
-- ('x' || <16 hex chars>)::bit(64) parses a fingerprint, # is bitwise XOR, and
-- the set bits of that XOR are the Hamming distance — so casting to text and
-- stripping the zeroes counts the differing bits.
-- Rows whose fingerprint is malformed, or whose match has since disappeared,
-- are skipped rather than failing the migration; they stay null and read as
-- "not recorded", exactly like the older rows.
UPDATE "Upload" u
SET "nearDuplicateDistance" = (
  SELECT length(
    replace(
      (('x' || u."simHash")::bit(64) # ('x' || m."simHash")::bit(64))::text,
      '0',
      ''
    )
  )
  FROM "Upload" m
  WHERE m."arweaveHash" = u."nearDuplicateOf"
    AND m."simHash" ~* '^[0-9a-f]{16}$'
)
WHERE u."nearDuplicateOf" IS NOT NULL
  AND u."simHash" ~* '^[0-9a-f]{16}$';
