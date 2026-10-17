-- #592 (ADR-0056): a New work intake writes candidates; Accept makes the cards.
CREATE TYPE "PlanCandidateStatus" AS ENUM ('pending', 'accepted', 'rejected');

ALTER TABLE "plans" ADD COLUMN "candidateStack" JSONB;

CREATE TABLE "plan_candidates" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "PlanTaskKind" NOT NULL,
    "body" TEXT NOT NULL,
    "stage" INTEGER,
    "status" "PlanCandidateStatus" NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "cardId" TEXT,
    "attachments" INTEGER NOT NULL DEFAULT 0,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_candidates_cardId_key" ON "plan_candidates"("cardId");

CREATE UNIQUE INDEX "plan_candidates_planId_position_key" ON "plan_candidates"("planId", "position");

ALTER TABLE "plan_candidates" ADD CONSTRAINT "plan_candidates_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plan_candidates" ADD CONSTRAINT "plan_candidates_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "plan_candidates" ADD CONSTRAINT "plan_candidates_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
