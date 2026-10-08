-- CreateEnum
CREATE TYPE "ActivityCategory" AS ENUM ('fleet', 'runner', 'audit');

-- CreateEnum
CREATE TYPE "ActivitySeverity" AS ENUM ('info', 'ok', 'warn', 'danger');

-- CreateEnum
CREATE TYPE "ActivityActorType" AS ENUM ('user', 'runner', 'orchestrator', 'system');

-- CreateEnum
CREATE TYPE "ActivitySourceKind" AS ENUM ('event', 'audit');

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('orchestrator_slot', 'skill', 'schedule');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('running', 'blocked', 'waiting_person', 'succeeded', 'failed', 'abandoned');

-- CreateEnum
CREATE TYPE "RunOutput" AS ENUM ('report', 'pr');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('orchestrator', 'user', 'schedule', 'webhook');

-- CreateTable
CREATE TABLE "activity_items" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT,
    "category" "ActivityCategory" NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "ActivitySeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "actorType" "ActivityActorType" NOT NULL,
    "actorId" TEXT,
    "slot" TEXT,
    "issue" INTEGER,
    "prNumber" INTEGER,
    "link" TEXT,
    "data" JSONB NOT NULL,
    "sourceKind" "ActivitySourceKind" NOT NULL,
    "sourceId" BIGINT NOT NULL,

    CONSTRAINT "activity_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_projector_state" (
    "id" TEXT NOT NULL,
    "eventsCursor" BIGINT NOT NULL DEFAULT 0,
    "auditCursor" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activity_projector_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "kind" "RunKind" NOT NULL,
    "projectId" TEXT NOT NULL,
    "slotId" TEXT,
    "issue" INTEGER,
    "title" TEXT,
    "runtime" "Runtime",
    "model" TEXT,
    "profileKey" TEXT,
    "args" JSONB,
    "output" "RunOutput",
    "status" "RunStatus" NOT NULL,
    "outcome" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "triggeredByType" "RunTrigger" NOT NULL,
    "triggeredById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "slotSeq" BIGINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_items_projectId_ts_id_idx" ON "activity_items"("projectId", "ts", "id");

-- CreateIndex
CREATE INDEX "activity_items_ts_id_idx" ON "activity_items"("ts", "id");

-- CreateIndex
CREATE INDEX "activity_items_type_ts_idx" ON "activity_items"("type", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "activity_items_sourceKind_sourceId_key" ON "activity_items"("sourceKind", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "runs_slotId_key" ON "runs"("slotId");

-- CreateIndex
CREATE INDEX "runs_projectId_startedAt_idx" ON "runs"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "runs_projectId_status_idx" ON "runs"("projectId", "status");

-- AddForeignKey
ALTER TABLE "activity_items" ADD CONSTRAINT "activity_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
