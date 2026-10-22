-- CreateEnum
CREATE TYPE "CardWorkClass" AS ENUM ('mechanical', 'deciding', 'unsure');

-- CreateEnum
CREATE TYPE "CardEscalationReason" AS ENUM ('misclassified', 'gave_up');

-- AlterEnum
ALTER TYPE "CardRoundTrigger" ADD VALUE 'escalation';

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "escalationNote" TEXT,
ADD COLUMN     "escalationReason" "CardEscalationReason",
ADD COLUMN     "sessionEffort" "CardEffort",
ADD COLUMN     "sessionModel" TEXT,
ADD COLUMN     "workClass" "CardWorkClass",
ADD COLUMN     "workSignals" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "board_card_rounds" ADD COLUMN     "escalation" "CardEscalationReason";
