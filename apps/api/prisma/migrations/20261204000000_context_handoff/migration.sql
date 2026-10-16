-- #449 (ADR-0042): Context handoff — the API's copy of a handoff note (only
-- for a project with session content on), and how each card round started.
CREATE TYPE "CardRestartMode" AS ENUM ('resume', 'fresh', 'first');

CREATE TYPE "HandoffSubjectKind" AS ENUM ('card', 'run');

CREATE TYPE "HandoffUpdatedBy" AS ENUM ('agent', 'haiku', 'person');

ALTER TABLE "board_card_rounds" ADD COLUMN     "restartEstimate" JSONB,
ADD COLUMN     "restartMode" "CardRestartMode",
ADD COLUMN     "sessionId" UUID,
ADD COLUMN     "warmupMs" INTEGER,
ADD COLUMN     "warmupTokens" INTEGER;

CREATE TABLE "handoff_notes" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "subjectKind" "HandoffSubjectKind" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "personLines" JSONB NOT NULL DEFAULT '[]',
    "updatedBy" "HandoffUpdatedBy" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "handoff_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "handoff_notes_projectId_idx" ON "handoff_notes"("projectId");

CREATE UNIQUE INDEX "handoff_notes_subjectKind_subjectId_key" ON "handoff_notes"("subjectKind", "subjectId");

ALTER TABLE "handoff_notes" ADD CONSTRAINT "handoff_notes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
