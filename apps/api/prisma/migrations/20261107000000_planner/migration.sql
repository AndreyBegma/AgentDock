-- CreateEnum
CREATE TYPE "PlanMode" AS ENUM ('batch', 'dialogue');

-- CreateEnum
CREATE TYPE "PlanVisibility" AS ENUM ('private', 'project');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('clarifying', 'drafting', 'reviewing', 'sending', 'sent', 'archived');

-- CreateEnum
CREATE TYPE "PlanTaskKind" AS ENUM ('bug', 'feature');

-- CreateEnum
CREATE TYPE "PlanTaskStatus" AS ENUM ('draft', 'needs_talk', 'ready', 'approved', 'rejected', 'rewrite_requested', 'issued');

-- CreateEnum
CREATE TYPE "PlanTurnAction" AS ENUM ('decompose', 'clarify', 'grill', 'write', 'revise');

-- CreateEnum
CREATE TYPE "PlanTurnPhase" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "PlannerSpecOutput" AS ENUM ('docs_pr', 'issue_body');

-- AlterEnum
ALTER TYPE "RunKind" ADD VALUE 'plan';

-- CreateTable
CREATE TABLE "planner_instructions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planner_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planner_settings" (
    "projectId" TEXT NOT NULL,
    "specOutput" "PlannerSpecOutput" NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planner_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "authorId" TEXT,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "mode" "PlanMode" NOT NULL,
    "visibility" "PlanVisibility" NOT NULL DEFAULT 'private',
    "status" "PlanStatus" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sessionId" UUID NOT NULL,
    "instructionsId" TEXT NOT NULL,
    "contractVersion" INTEGER NOT NULL,
    "profileKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "worktree" TEXT,
    "docsPrNumber" INTEGER,
    "docsPrUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_tasks" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL,
    "kind" "PlanTaskKind" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "PlanTaskStatus" NOT NULL DEFAULT 'draft',
    "questions" JSONB NOT NULL DEFAULT '[]',
    "document" TEXT,
    "rewriteComment" TEXT,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "sessionId" UUID,
    "issueNumber" INTEGER,
    "issueUrl" TEXT,
    "queuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_turns" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "taskId" TEXT,
    "runId" TEXT NOT NULL,
    "action" "PlanTurnAction" NOT NULL,
    "authorId" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "resultText" TEXT,
    "phase" "PlanTurnPhase" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "plan_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "planner_instructions_projectId_version_key" ON "planner_instructions"("projectId", "version");

-- Spec 172 D11: one global version per number. The unique index above does not
-- cover the global rows, because Postgres treats NULL project ids as distinct.
CREATE UNIQUE INDEX "planner_instructions_global_version_key" ON "planner_instructions"("version")
    WHERE "projectId" IS NULL;

-- CreateIndex
CREATE INDEX "plans_projectId_updatedAt_idx" ON "plans"("projectId", "updatedAt");

-- CreateIndex
CREATE INDEX "plans_authorId_idx" ON "plans"("authorId");

-- CreateIndex
CREATE INDEX "plan_tasks_planId_planVersion_idx" ON "plan_tasks"("planId", "planVersion");

-- CreateIndex
CREATE INDEX "plan_tasks_issueNumber_idx" ON "plan_tasks"("issueNumber");

-- CreateIndex
CREATE UNIQUE INDEX "plan_tasks_planId_key_planVersion_key" ON "plan_tasks"("planId", "key", "planVersion");

-- CreateIndex
CREATE UNIQUE INDEX "plan_turns_runId_key" ON "plan_turns"("runId");

-- CreateIndex
CREATE INDEX "plan_turns_planId_createdAt_idx" ON "plan_turns"("planId", "createdAt");

-- CreateIndex
CREATE INDEX "plan_turns_taskId_createdAt_idx" ON "plan_turns"("taskId", "createdAt");

-- AddForeignKey
ALTER TABLE "planner_instructions" ADD CONSTRAINT "planner_instructions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planner_instructions" ADD CONSTRAINT "planner_instructions_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planner_settings" ADD CONSTRAINT "planner_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planner_settings" ADD CONSTRAINT "planner_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_instructionsId_fkey" FOREIGN KEY ("instructionsId") REFERENCES "planner_instructions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "plan_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
