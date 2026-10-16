-- #447 (ADR-0040): Steward — the project setting, the incidents it opens, the
-- digests it delivers, and the run kind its local haiku is priced under.
CREATE TYPE "StewardSubjectKind" AS ENUM ('card_round', 'run', 'fleet_slot');

CREATE TYPE "StewardIncidentKind" AS ENUM ('api_error', 'dialog', 'permission_prompt', 'quota', 'silent', 'dead_session', 'trailer', 'unknown');

CREATE TYPE "StewardIncidentStatus" AS ENUM ('open', 'resolved', 'escalated');

CREATE TYPE "StewardDigestTrigger" AS ENUM ('daily', 'away_off');

ALTER TYPE "RunKind" ADD VALUE 'steward';

CREATE TABLE "steward_settings" (
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "silenceMinutes" INTEGER NOT NULL DEFAULT 10,
    "digestTime" TEXT NOT NULL DEFAULT '09:00',
    "autoNudge" BOOLEAN NOT NULL DEFAULT true,
    "autoDismiss" BOOLEAN NOT NULL DEFAULT true,
    "autoResume" BOOLEAN NOT NULL DEFAULT true,
    "trailerGuard" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "steward_settings_pkey" PRIMARY KEY ("projectId")
);

CREATE TABLE "steward_incidents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "subjectKind" "StewardSubjectKind" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "kind" "StewardIncidentKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "actions" JSONB NOT NULL DEFAULT '[]',
    "status" "StewardIncidentStatus" NOT NULL DEFAULT 'open',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "notifiedReason" TEXT,

    CONSTRAINT "steward_incidents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "steward_digests" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "trigger" "StewardDigestTrigger" NOT NULL,
    "from" TIMESTAMP(3) NOT NULL,
    "to" TIMESTAMP(3) NOT NULL,
    "content" JSONB NOT NULL,
    "prose" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steward_digests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "steward_digests_projectId_createdAt_idx" ON "steward_digests"("projectId", "createdAt");

CREATE INDEX "steward_incidents_projectId_openedAt_idx" ON "steward_incidents"("projectId", "openedAt");

CREATE INDEX "steward_incidents_subjectKind_subjectId_status_idx" ON "steward_incidents"("subjectKind", "subjectId", "status");

ALTER TABLE "steward_settings" ADD CONSTRAINT "steward_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "steward_settings" ADD CONSTRAINT "steward_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "steward_incidents" ADD CONSTRAINT "steward_incidents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "steward_digests" ADD CONSTRAINT "steward_digests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
