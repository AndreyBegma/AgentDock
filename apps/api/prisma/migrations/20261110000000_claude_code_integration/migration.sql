-- CreateEnum
CREATE TYPE "SessionOrigin" AS ENUM ('unknown', 'worker', 'run', 'manual');

-- CreateEnum
CREATE TYPE "SessionLiveState" AS ENUM ('idle', 'working', 'waiting', 'ended');

-- CreateEnum
CREATE TYPE "SessionContentKind" AS ENUM ('prompt', 'response', 'tool_input', 'tool_output');

-- CreateEnum
CREATE TYPE "ActionRequestKind" AS ENUM ('tool_use', 'orchestrator_start', 'orchestrator_stop', 'pr_approve');

-- CreateEnum
CREATE TYPE "ActionRequestStatus" AS ENUM ('pending', 'approved', 'denied', 'expired', 'executed', 'failed');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "sessionContentRetentionDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "shipSessionContent" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "runners" ADD COLUMN     "awayMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "localUserId" TEXT;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "issue" INTEGER,
ADD COLUMN     "liveState" "SessionLiveState",
ADD COLUMN     "origin" "SessionOrigin" NOT NULL DEFAULT 'unknown',
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "tmuxSession" TEXT;

-- CreateTable
CREATE TABLE "session_contents" (
    "id" BIGSERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "SessionContentKind" NOT NULL,
    "toolUseId" TEXT,
    "toolName" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_requests" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "sessionId" TEXT,
    "requestedById" TEXT,
    "kind" "ActionRequestKind" NOT NULL,
    "summary" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "status" "ActionRequestStatus" NOT NULL DEFAULT 'pending',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "result" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_contents_sessionId_at_idx" ON "session_contents"("sessionId", "at");

-- CreateIndex
CREATE INDEX "session_contents_projectId_createdAt_idx" ON "session_contents"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "action_requests_projectId_status_createdAt_idx" ON "action_requests"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "action_requests_status_expiresAt_idx" ON "action_requests"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "sessions_projectId_origin_lastEventAt_idx" ON "sessions"("projectId", "origin", "lastEventAt");

-- AddForeignKey
ALTER TABLE "runners" ADD CONSTRAINT "runners_localUserId_fkey" FOREIGN KEY ("localUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_contents" ADD CONSTRAINT "session_contents_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_contents" ADD CONSTRAINT "session_contents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: a local request acts as the runner's creator until an admin
-- changes it (spec 201 D8).
UPDATE "runners" SET "localUserId" = "createdById" WHERE "localUserId" IS NULL;
