-- CreateEnum
CREATE TYPE "RoundSource" AS ENUM ('scraped', 'events');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('dispatched', 'running', 'idle', 'prompt', 'quota', 'stale', 'ended');

-- CreateEnum
CREATE TYPE "PaneState" AS ENUM ('busy', 'prompt', 'idle', 'quota');

-- CreateEnum
CREATE TYPE "PrState" AS ENUM ('open', 'merged', 'closed');

-- CreateEnum
CREATE TYPE "PrChecks" AS ENUM ('pending', 'green', 'red');

-- CreateEnum
CREATE TYPE "CheckpointKind" AS ENUM ('picked_up', 'plan_ready', 'implementation_done', 'pr_open', 'blocked', 'misclassified', 'other');

-- CreateEnum
CREATE TYPE "OrchestratorStatus" AS ENUM ('running', 'idle', 'absent');

-- CreateTable
CREATE TABLE "rounds" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "occupied" INTEGER NOT NULL,
    "max" INTEGER NOT NULL,
    "free" INTEGER NOT NULL,
    "decisions" JSONB NOT NULL,
    "source" "RoundSource" NOT NULL,
    "boardPath" TEXT NOT NULL,
    "lastSeq" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slots" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issue" INTEGER,
    "branch" TEXT,
    "worktree" TEXT NOT NULL,
    "runtime" "Runtime" NOT NULL DEFAULT 'claude',
    "model" TEXT,
    "modelWhy" TEXT,
    "owns" JSONB NOT NULL,
    "never" JSONB NOT NULL,
    "lead" BOOLEAN,
    "round" TEXT,
    "status" "SlotStatus" NOT NULL,
    "sessionAlive" BOOLEAN,
    "pane" "PaneState",
    "worktreeExists" BOOLEAN NOT NULL DEFAULT true,
    "ahead" INTEGER,
    "behind" INTEGER,
    "dirty" BOOLEAN,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "prState" "PrState",
    "prChecks" "PrChecks",
    "prMergeable" BOOLEAN,
    "lastCheckpoint" "CheckpointKind",
    "lastSeq" BIGINT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slot_checkpoints" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "kind" "CheckpointKind" NOT NULL,
    "heading" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slot_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_orchestrators" (
    "projectId" TEXT NOT NULL,
    "status" "OrchestratorStatus",
    "session" TEXT,
    "since" TIMESTAMP(3),
    "boardError" JSONB,
    "lastSeq" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_orchestrators_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "rounds_projectId_date_label_key" ON "rounds"("projectId", "date", "label");

-- CreateIndex
CREATE INDEX "slots_projectId_status_idx" ON "slots"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "slots_projectId_name_startedAt_key" ON "slots"("projectId", "name", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "slot_checkpoints_slotId_position_key" ON "slot_checkpoints"("slotId", "position");

-- AddForeignKey
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slots" ADD CONSTRAINT "slots_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_checkpoints" ADD CONSTRAINT "slot_checkpoints_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_orchestrators" ADD CONSTRAINT "fleet_orchestrators_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
