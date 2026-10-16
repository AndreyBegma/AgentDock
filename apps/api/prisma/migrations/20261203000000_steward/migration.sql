-- #447 (ADR-0040): Steward — the project setting and the incidents it opens.
CREATE TYPE "StewardSubjectKind" AS ENUM ('card_round', 'run', 'fleet_slot');

CREATE TYPE "StewardIncidentKind" AS ENUM ('api_error', 'dialog', 'permission_prompt', 'quota', 'silent', 'dead_session', 'trailer', 'unknown');

CREATE TYPE "StewardIncidentStatus" AS ENUM ('open', 'resolved', 'escalated');

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

CREATE INDEX "steward_incidents_projectId_openedAt_idx" ON "steward_incidents"("projectId", "openedAt");

CREATE INDEX "steward_incidents_subjectKind_subjectId_status_idx" ON "steward_incidents"("subjectKind", "subjectId", "status");

ALTER TABLE "steward_settings" ADD CONSTRAINT "steward_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "steward_settings" ADD CONSTRAINT "steward_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "steward_incidents" ADD CONSTRAINT "steward_incidents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
