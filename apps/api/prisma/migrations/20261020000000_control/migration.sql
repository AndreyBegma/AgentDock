-- CreateEnum
CREATE TYPE "CommandRunStatus" AS ENUM ('requested', 'ok', 'error', 'unknown');

-- CreateEnum
CREATE TYPE "OrchestratorPermissionMode" AS ENUM ('auto', 'acceptEdits', 'bypassPermissions', 'manual');

-- CreateTable
CREATE TABLE "command_runs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "userId" TEXT,
    "command" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "slot" TEXT,
    "status" "CommandRunStatus" NOT NULL DEFAULT 'requested',
    "error" JSONB,
    "result" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "command_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_orchestrator_settings" (
    "projectId" TEXT NOT NULL,
    "profileId" TEXT,
    "model" TEXT NOT NULL DEFAULT 'opus',
    "permissionMode" "OrchestratorPermissionMode" NOT NULL DEFAULT 'auto',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_orchestrator_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE INDEX "command_runs_projectId_requestedAt_idx" ON "command_runs"("projectId", "requestedAt");

-- AddForeignKey
ALTER TABLE "command_runs" ADD CONSTRAINT "command_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_runs" ADD CONSTRAINT "command_runs_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_runs" ADD CONSTRAINT "command_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_orchestrator_settings" ADD CONSTRAINT "project_orchestrator_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_orchestrator_settings" ADD CONSTRAINT "project_orchestrator_settings_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "runtime_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_orchestrator_settings" ADD CONSTRAINT "project_orchestrator_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
