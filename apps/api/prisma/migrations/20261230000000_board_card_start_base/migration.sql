-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "startBase" TEXT,
ADD COLUMN     "startCardNumber" INTEGER,
ADD COLUMN     "startMissing" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
