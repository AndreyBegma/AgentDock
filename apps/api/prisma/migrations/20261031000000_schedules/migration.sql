-- CreateEnum
CREATE TYPE "ScheduleMissedPolicy" AS ENUM ('skip', 'catch_up');

-- CreateEnum
CREATE TYPE "ScheduleDisabledReason" AS ENUM ('manual', 'failing', 'creator_not_authorized');

-- CreateEnum
CREATE TYPE "ScheduleFiringKind" AS ENUM ('cron', 'catch_up', 'manual');

-- CreateEnum
CREATE TYPE "ScheduleFiringStatus" AS ENUM ('due', 'started', 'noop', 'skipped', 'failed', 'succeeded');

-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" JSONB NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "missedPolicy" "ScheduleMissedPolicy" NOT NULL DEFAULT 'skip',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledReason" "ScheduleDisabledReason",
    "nextRunAt" TIMESTAMPTZ(3),
    "lastRunAt" TIMESTAMPTZ(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_firings" (
    "id" BIGSERIAL NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMPTZ(3) NOT NULL,
    "firedAt" TIMESTAMPTZ(3),
    "kind" "ScheduleFiringKind" NOT NULL,
    "status" "ScheduleFiringStatus" NOT NULL,
    "reason" TEXT,
    "missedCount" INTEGER NOT NULL DEFAULT 0,
    "runId" TEXT,
    "commandRunId" TEXT,
    "error" JSONB,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "schedule_firings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedules_enabled_nextRunAt_idx" ON "schedules"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "schedules_projectId_idx" ON "schedules"("projectId");

-- CreateIndex
CREATE INDEX "schedule_firings_scheduleId_scheduledFor_idx" ON "schedule_firings"("scheduleId", "scheduledFor");

-- CreateIndex
CREATE INDEX "schedule_firings_status_idx" ON "schedule_firings"("status");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_firings_scheduleId_scheduledFor_kind_key" ON "schedule_firings"("scheduleId", "scheduledFor", "kind");

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_firings" ADD CONSTRAINT "schedule_firings_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_firings" ADD CONSTRAINT "schedule_firings_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
