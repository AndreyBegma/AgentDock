-- CreateTable
CREATE TABLE "github_app" (
    "id" TEXT NOT NULL DEFAULT 'app',
    "appId" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "ownerLogin" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "webhookSecret" TEXT NOT NULL,
    "clientSecret" TEXT,
    "hookActive" BOOLEAN NOT NULL,
    "signatureFailures" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveryAt" TIMESTAMP(3),
    "lastSignatureFailureAt" TIMESTAMP(3),
    "hookCheckedAt" TIMESTAMP(3),
    "hookCheckOk" BOOLEAN,
    "registeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_app_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_installations" (
    "id" INTEGER NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "suspended" BOOLEAN NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_installation_repos" (
    "installationId" INTEGER NOT NULL,
    "repoId" BIGINT NOT NULL,
    "fullName" TEXT NOT NULL,

    CONSTRAINT "github_installation_repos_pkey" PRIMARY KEY ("installationId","repoId")
);

-- CreateTable
CREATE TABLE "github_deliveries" (
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "fullName" TEXT,
    "installationId" INTEGER,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handled" BOOLEAN NOT NULL,
    "projectsMatched" INTEGER NOT NULL,

    CONSTRAINT "github_deliveries_pkey" PRIMARY KEY ("deliveryId")
);

-- CreateTable
CREATE TABLE "github_project_health" (
    "projectId" TEXT NOT NULL,
    "covered" BOOLEAN NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_project_health_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE INDEX "github_installation_repos_fullName_idx" ON "github_installation_repos"("fullName");

-- CreateIndex
CREATE INDEX "github_deliveries_installationId_receivedAt_idx" ON "github_deliveries"("installationId", "receivedAt");

-- CreateIndex
CREATE INDEX "github_deliveries_receivedAt_idx" ON "github_deliveries"("receivedAt");

-- AddForeignKey
ALTER TABLE "github_app" ADD CONSTRAINT "github_app_registeredById_fkey" FOREIGN KEY ("registeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_installation_repos" ADD CONSTRAINT "github_installation_repos_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "github_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_project_health" ADD CONSTRAINT "github_project_health_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Spec 27 D9 (notes): `events.seq` of an API-written `github.*` row is the
-- negation of this sequence's next value. Runner seqs are positive and the ack
-- cursor only reads `seq > ackedSeq >= 0`, so the two never meet. Not modelled
-- in Prisma, which does not manage standalone sequences.
CREATE SEQUENCE "github_event_seq" AS BIGINT START WITH 1;
