-- #445 (ADR-0039): Token saver — the project setting, the filter's per-command
-- stats, and the artifact guard's mark on the run.
CREATE TYPE "TokenSaverRunKind" AS ENUM ('card', 'skill', 'plan', 'card_assess', 'card_capture', 'ui_profile', 'text_normalize', 'orchestrator');

ALTER TABLE "runs" ADD COLUMN "artifactIncomplete" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "token_saver_settings" (
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mcpAllow" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_saver_settings_pkey" PRIMARY KEY ("projectId")
);

CREATE TABLE "token_saver_stats" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT,
    "runKind" "TokenSaverRunKind" NOT NULL,
    "filter" TEXT NOT NULL,
    "rawBytes" INTEGER NOT NULL,
    "keptBytes" INTEGER NOT NULL,
    "bypassed" BOOLEAN NOT NULL,
    "passedThrough" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_saver_stats_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "token_saver_stats_projectId_createdAt_idx" ON "token_saver_stats"("projectId", "createdAt");

CREATE INDEX "token_saver_stats_runId_idx" ON "token_saver_stats"("runId");

ALTER TABLE "token_saver_settings" ADD CONSTRAINT "token_saver_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "token_saver_settings" ADD CONSTRAINT "token_saver_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "token_saver_stats" ADD CONSTRAINT "token_saver_stats_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "token_saver_stats" ADD CONSTRAINT "token_saver_stats_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
