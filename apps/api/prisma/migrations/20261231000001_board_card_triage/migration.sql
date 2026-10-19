-- CreateEnum
CREATE TYPE "BoardCardTriageState" AS ENUM ('pending', 'ready', 'failed', 'hidden');

-- CreateTable
CREATE TABLE "board_card_triage" (
    "cardId" TEXT NOT NULL,
    "state" "BoardCardTriageState" NOT NULL DEFAULT 'pending',
    "userId" TEXT,
    "provider" "LlmProvider",
    "duplicates" JSONB,
    "suggestedKind" "BoardCardKind",
    "kindReason" TEXT,
    "suggestedPriority" TEXT,
    "priorityReason" TEXT,
    "duplicatesDismissedAt" TIMESTAMP(3),
    "kindDismissedAt" TIMESTAMP(3),
    "kindAppliedAt" TIMESTAMP(3),
    "priorityDismissedAt" TIMESTAMP(3),
    "priorityAppliedAt" TIMESTAMP(3),
    "llmCallId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_card_triage_pkey" PRIMARY KEY ("cardId")
);

-- AddForeignKey
ALTER TABLE "board_card_triage" ADD CONSTRAINT "board_card_triage_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

