-- #379 (ADR-0036): specs written into an external docs repository — the docs
-- source's spec folder, and the docs pull requests of cards and plans.

-- AlterTable
ALTER TABLE "docs_sources" ADD COLUMN     "specDir" TEXT;

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "docsPrRepo" TEXT,
ADD COLUMN     "designPrNumber" INTEGER,
ADD COLUMN     "designPrUrl" TEXT,
ADD COLUMN     "docsPrMergedAt" TIMESTAMP(3),
ADD COLUMN     "designPrMergedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "specRepo" TEXT,
ADD COLUMN     "specPrNumber" INTEGER,
ADD COLUMN     "specPrUrl" TEXT;
