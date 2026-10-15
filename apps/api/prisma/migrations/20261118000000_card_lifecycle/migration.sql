-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "autoRunError" TEXT,
ADD COLUMN     "autoRunFailedAt" TIMESTAMP(3),
ADD COLUMN     "autoRunMessage" TEXT;

-- AlterTable
-- #273 D5: added nullable, backfilled from the card's current text, then NOT
-- NULL. Edits made before this migration are therefore never sent.
ALTER TABLE "board_card_rounds" ADD COLUMN     "cardBody" TEXT,
ADD COLUMN     "cardKind" "BoardCardKind",
ADD COLUMN     "cardTitle" TEXT;

UPDATE "board_card_rounds" AS r
SET "cardTitle" = c."title",
    "cardBody" = c."body",
    "cardKind" = c."kind"
FROM "board_cards" AS c
WHERE c."id" = r."cardId";

ALTER TABLE "board_card_rounds" ALTER COLUMN "cardBody" SET NOT NULL,
ALTER COLUMN "cardKind" SET NOT NULL,
ALTER COLUMN "cardTitle" SET NOT NULL;
