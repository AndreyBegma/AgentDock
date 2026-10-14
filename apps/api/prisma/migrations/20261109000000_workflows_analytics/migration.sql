-- Workflows analytics (#161): compactions, session errors, subagent types,
-- and the per-root-session projection the /workflows routes read. Additive.

-- CreateEnum
CREATE TYPE "CompactionTrigger" AS ENUM ('auto', 'manual');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "agentType" TEXT;

-- CreateTable
CREATE TABLE "session_compactions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "compactionId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "trigger" "CompactionTrigger" NOT NULL,
    "preTokens" INTEGER,

    CONSTRAINT "session_compactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_errors" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "errorId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "status" INTEGER,

    CONSTRAINT "session_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_workflow_marks" (
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "session_workflow_marks_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "session_workflows" (
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT,
    "runtime" "Runtime" NOT NULL,
    "profileKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "depth" INTEGER NOT NULL,
    "subagents" INTEGER NOT NULL,
    "compactions" INTEGER NOT NULL,
    "primaryAgentType" TEXT NOT NULL,
    "errored" BOOLEAN NOT NULL,
    "lastTurnOpen" BOOLEAN NOT NULL,
    "builtAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_workflows_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "session_tool_transitions" (
    "sessionId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "errors" INTEGER NOT NULL,

    CONSTRAINT "session_tool_transitions_pkey" PRIMARY KEY ("sessionId","from","to")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_compactions_sessionId_compactionId_key" ON "session_compactions"("sessionId", "compactionId");

-- CreateIndex
CREATE UNIQUE INDEX "session_errors_sessionId_errorId_key" ON "session_errors"("sessionId", "errorId");

-- CreateIndex
CREATE INDEX "session_workflows_startedAt_idx" ON "session_workflows"("startedAt");

-- CreateIndex
CREATE INDEX "session_workflows_projectId_startedAt_idx" ON "session_workflows"("projectId", "startedAt");

-- AddForeignKey
ALTER TABLE "session_compactions" ADD CONSTRAINT "session_compactions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_errors" ADD CONSTRAINT "session_errors_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_workflow_marks" ADD CONSTRAINT "session_workflow_marks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_workflows" ADD CONSTRAINT "session_workflows_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_workflows" ADD CONSTRAINT "session_workflows_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_tool_transitions" ADD CONSTRAINT "session_tool_transitions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session_workflows"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE;
