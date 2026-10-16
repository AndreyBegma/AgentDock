-- AlterTable
ALTER TABLE "board_card_rounds" ADD COLUMN     "autoRunAfter" INTEGER;

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "autoRunAfter" INTEGER,
ADD COLUMN     "autoRunWhenReady" BOOLEAN NOT NULL DEFAULT false;
