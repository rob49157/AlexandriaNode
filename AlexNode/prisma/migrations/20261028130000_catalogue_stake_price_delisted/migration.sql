-- Catalogue fields the event listener keeps in step from stake and rent events:
-- when the review window opened, the rental price, and delisting.
-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "delisted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pricePerDay" TEXT,
ADD COLUMN     "stakedAt" TIMESTAMP(3);

-- Backfill from events the listener has already stored. Its cursor is past them,
-- so it will not apply them again. The newest event wins, as in a live sync.
UPDATE "Upload" AS u
SET "stakedAt" = e."timestamp"
FROM (
    SELECT DISTINCT ON ("arweaveHash") "arweaveHash", "timestamp"
    FROM "Event"
    WHERE "contract" = 'stake' AND "eventName" = 'Staked' AND "arweaveHash" IS NOT NULL
    ORDER BY "arweaveHash", "blockNumber" DESC, "logIndex" DESC
) AS e
WHERE u."arweaveHash" = e."arweaveHash";

UPDATE "Upload" AS u
SET "pricePerDay" = e."price"
FROM (
    SELECT DISTINCT ON ("arweaveHash") "arweaveHash", "args"->>'price' AS "price"
    FROM "Event"
    WHERE "contract" = 'rent' AND "eventName" = 'BookPriceSet' AND "arweaveHash" IS NOT NULL
    ORDER BY "arweaveHash", "blockNumber" DESC, "logIndex" DESC
) AS e
WHERE u."arweaveHash" = e."arweaveHash";

UPDATE "Upload"
SET "delisted" = true
WHERE "arweaveHash" IN (
    SELECT "arweaveHash"
    FROM "Event"
    WHERE "contract" = 'rent' AND "eventName" = 'BookDelisted' AND "arweaveHash" IS NOT NULL
);
