-- CreateEnum
CREATE TYPE "InboundDeliveryStatus" AS ENUM ('accepted', 'skipped', 'rejected', 'started', 'failed');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "WebhookCircuitState" AS ENUM ('closed', 'open', 'half_open');

-- CreateTable
CREATE TABLE "inbound_triggers" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "action" JSONB NOT NULL,
    "allowedPaths" TEXT[],
    "valuePattern" TEXT,
    "secret" TEXT NOT NULL,
    "previousSecret" TEXT,
    "previousSecretUntil" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledReason" TEXT,
    "bucketTokens" INTEGER NOT NULL,
    "bucketRefilledAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "triggerId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "InboundDeliveryStatus" NOT NULL,
    "reason" TEXT,
    "renderedArgs" JSONB,
    "runId" TEXT,
    "commandRunId" TEXT,
    "sourceIp" TEXT,

    CONSTRAINT "inbound_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "projectIds" TEXT[],
    "secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "circuitState" "WebhookCircuitState" NOT NULL DEFAULT 'closed',
    "circuitOpenedAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventId" BIGINT,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_dispatcher_state" (
    "id" TEXT NOT NULL,
    "eventsCursor" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_dispatcher_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_triggers_publicId_key" ON "inbound_triggers"("publicId");

-- CreateIndex
CREATE INDEX "inbound_triggers_projectId_idx" ON "inbound_triggers"("projectId");

-- CreateIndex
CREATE INDEX "inbound_deliveries_triggerId_receivedAt_idx" ON "inbound_deliveries"("triggerId", "receivedAt");

-- CreateIndex
CREATE INDEX "inbound_deliveries_receivedAt_idx" ON "inbound_deliveries"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_deliveries_triggerId_deliveryId_key" ON "inbound_deliveries"("triggerId", "deliveryId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx" ON "webhook_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhookId_createdAt_idx" ON "webhook_deliveries"("webhookId", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_createdAt_idx" ON "webhook_deliveries"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_webhookId_eventId_key" ON "webhook_deliveries"("webhookId", "eventId");

-- AddForeignKey
ALTER TABLE "inbound_triggers" ADD CONSTRAINT "inbound_triggers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_triggers" ADD CONSTRAINT "inbound_triggers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_deliveries" ADD CONSTRAINT "inbound_deliveries_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "inbound_triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_deliveries" ADD CONSTRAINT "inbound_deliveries_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
