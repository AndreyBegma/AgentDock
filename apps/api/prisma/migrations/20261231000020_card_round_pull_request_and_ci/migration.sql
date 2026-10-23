-- #837: each round's pull request, head commit and that commit's checks.
-- AlterTable
ALTER TABLE "board_card_rounds" ADD COLUMN     "ciPassed" INTEGER,
ADD COLUMN     "ciState" "CardCiState",
ADD COLUMN     "ciTotal" INTEGER,
ADD COLUMN     "headAhead" INTEGER,
ADD COLUMN     "headSha" TEXT,
ADD COLUMN     "prNumber" INTEGER,
ADD COLUMN     "prUrl" TEXT;
