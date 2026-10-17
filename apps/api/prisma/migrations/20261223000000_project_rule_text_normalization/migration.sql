-- #584: a rule created from a scanned candidate is normalized to English (ADR-0027).
ALTER TYPE "TextOwnerType" ADD VALUE 'project_rule';

ALTER TABLE "text_normalizations" ADD COLUMN "ruleId" TEXT;

CREATE INDEX "text_normalizations_ruleId_createdAt_idx" ON "text_normalizations"("ruleId", "createdAt");

ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "project_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A request still has exactly one owner.
ALTER TABLE "text_normalizations" DROP CONSTRAINT "text_normalizations_owner_check";
ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_owner_check" CHECK (
    num_nonnulls("cardId", "roundId", "commentId", "planId", "taskId", "turnId", "ruleId") = 1
);
