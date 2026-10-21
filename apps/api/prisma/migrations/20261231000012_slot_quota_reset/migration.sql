-- AlterTable
ALTER TABLE "slots" ADD COLUMN     "quotaLimit" TEXT,
ADD COLUMN     "quotaResetsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "board_card_rounds" ADD COLUMN     "quotaLimit" TEXT,
ADD COLUMN     "quotaResetsAt" TIMESTAMP(3);
