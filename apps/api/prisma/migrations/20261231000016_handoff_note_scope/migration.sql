-- C-186 (security audit DA-11): a handoff note is scoped to its project and
-- goes with its card or run.

-- A note whose subject is gone, or is another project's, has no owner left.
DELETE FROM "handoff_notes" n
WHERE (n."subjectKind" = 'card' AND NOT EXISTS (
         SELECT 1 FROM "board_cards" c
         WHERE c."id" = n."subjectId" AND c."projectId" = n."projectId"))
   OR (n."subjectKind" = 'run' AND NOT EXISTS (
         SELECT 1 FROM "runs" r
         WHERE r."id" = n."subjectId" AND r."projectId" = n."projectId"));

ALTER TABLE "handoff_notes" ADD COLUMN "cardId" TEXT,
ADD COLUMN "runId" TEXT;

UPDATE "handoff_notes" SET "cardId" = "subjectId" WHERE "subjectKind" = 'card';
UPDATE "handoff_notes" SET "runId" = "subjectId" WHERE "subjectKind" = 'run';

-- Exactly one of cardId / runId, and it is the subject.
ALTER TABLE "handoff_notes" ADD CONSTRAINT "handoff_notes_subject_check" CHECK (
  ("subjectKind" = 'card' AND "cardId" = "subjectId" AND "runId" IS NULL)
  OR ("subjectKind" = 'run' AND "runId" = "subjectId" AND "cardId" IS NULL)
);

DROP INDEX "handoff_notes_projectId_idx";

DROP INDEX "handoff_notes_subjectKind_subjectId_key";

CREATE INDEX "handoff_notes_cardId_idx" ON "handoff_notes"("cardId");

CREATE INDEX "handoff_notes_runId_idx" ON "handoff_notes"("runId");

CREATE UNIQUE INDEX "handoff_notes_projectId_subjectKind_subjectId_key" ON "handoff_notes"("projectId", "subjectKind", "subjectId");

ALTER TABLE "handoff_notes" ADD CONSTRAINT "handoff_notes_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "handoff_notes" ADD CONSTRAINT "handoff_notes_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
