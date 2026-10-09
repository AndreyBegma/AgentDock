-- CreateEnum
CREATE TYPE "SkillScope" AS ENUM ('project', 'profile', 'plugin');

-- CreateEnum
CREATE TYPE "SkillRunPhase" AS ENUM ('queued', 'preparing', 'running', 'collecting', 'succeeded', 'failed', 'cancelled', 'timed_out');

-- CreateTable
CREATE TABLE "installed_skills" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "projectId" TEXT,
    "profileKey" TEXT,
    "scope" "SkillScope" NOT NULL,
    "runtime" "Runtime" NOT NULL,
    "name" TEXT NOT NULL,
    "invocation" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "description" TEXT,
    "argumentHint" TEXT,
    "source" TEXT,
    "commit" TEXT,
    "contentHash" TEXT,
    "pluginVersion" TEXT,
    "seenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installed_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_install_previews" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "commit" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "frontmatter" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "skill_install_previews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_runs" (
    "runId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "args" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "permissionMode" "OrchestratorPermissionMode" NOT NULL,
    "output" "RunOutput" NOT NULL,
    "phase" "SkillRunPhase" NOT NULL DEFAULT 'queued',
    "worktree" TEXT,
    "branch" TEXT,
    "tmuxSession" TEXT,
    "timeoutSec" INTEGER NOT NULL,
    "exitCode" INTEGER,
    "reportText" TEXT,
    "reportTruncated" BOOLEAN NOT NULL DEFAULT false,
    "changedFiles" JSONB,
    "changedFilesTotal" INTEGER,
    "patch" TEXT,
    "patchTruncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "skill_runs_pkey" PRIMARY KEY ("runId")
);

-- CreateIndex
CREATE INDEX "installed_skills_projectId_idx" ON "installed_skills"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "installed_skills_runnerId_scope_projectId_profileKey_runtim_key" ON "installed_skills"("runnerId", "scope", "projectId", "profileKey", "runtime", "name");

-- CreateIndex
CREATE INDEX "skill_install_previews_expiresAt_idx" ON "skill_install_previews"("expiresAt");

-- CreateIndex
CREATE INDEX "skill_runs_phase_idx" ON "skill_runs"("phase");

-- AddForeignKey
ALTER TABLE "installed_skills" ADD CONSTRAINT "installed_skills_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installed_skills" ADD CONSTRAINT "installed_skills_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_install_previews" ADD CONSTRAINT "skill_install_previews_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_install_previews" ADD CONSTRAINT "skill_install_previews_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_install_previews" ADD CONSTRAINT "skill_install_previews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
