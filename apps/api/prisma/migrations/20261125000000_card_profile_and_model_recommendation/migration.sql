-- AlterEnum
ALTER TYPE "RunKind" ADD VALUE 'card_assess';

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "assessRunId" TEXT,
ADD COLUMN     "assessedAt" TIMESTAMP(3),
ADD COLUMN     "assessmentHash" TEXT,
ADD COLUMN     "designModel" TEXT,
ADD COLUMN     "profileKey" TEXT,
ADD COLUMN     "recommendedDesignModel" TEXT,
ADD COLUMN     "recommendedDesignReason" TEXT,
ADD COLUMN     "recommendedModel" TEXT,
ADD COLUMN     "recommendedReason" TEXT;
