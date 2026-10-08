-- CreateEnum
CREATE TYPE "NotificationDeliveryChannel" AS ENUM ('telegram');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('pending', 'sent', 'digested', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "notifications" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "projectId" TEXT,
    "runnerId" TEXT,
    "slot" TEXT,
    "issue" INTEGER,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "eventId" BIGINT,
    "lastEventId" BIGINT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,
    "readAt" TIMESTAMP(3),
    "muted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_rules" (
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "inApp" BOOLEAN NOT NULL,
    "telegram" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("userId","kind")
);

-- CreateTable
CREATE TABLE "notification_mutes" (
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "until" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_mutes_pkey" PRIMARY KEY ("userId","projectId")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "notificationId" BIGINT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "NotificationDeliveryChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "digestId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_links" (
    "userId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "username" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_links_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "telegram_link_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_link_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_matcher_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "eventsCursor" BIGINT NOT NULL,
    "telegramUpdateOffset" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_matcher_state_pkey" PRIMARY KEY ("id"),
    -- A single row (spec 22 D4).
    CONSTRAINT "notification_matcher_state_single_row" CHECK ("id" = 1)
);

-- CreateTable
CREATE TABLE "runner_incidents" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "runner_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_lastAt_idx" ON "notifications"("userId", "readAt", "lastAt");

-- CreateIndex
CREATE INDEX "notifications_userId_lastAt_id_idx" ON "notifications"("userId", "lastAt", "id");

-- CreateIndex
CREATE INDEX "notifications_userId_kind_firstAt_idx" ON "notifications"("userId", "kind", "firstAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_eventId_userId_kind_key" ON "notifications"("eventId", "userId", "kind");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_nextAttemptAt_idx" ON "notification_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "notification_deliveries_userId_channel_sentAt_idx" ON "notification_deliveries"("userId", "channel", "sentAt");

-- CreateIndex
CREATE INDEX "notification_deliveries_digestId_idx" ON "notification_deliveries"("digestId");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_links_chatId_key" ON "telegram_links"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_link_codes_codeHash_key" ON "telegram_link_codes"("codeHash");

-- CreateIndex
CREATE INDEX "telegram_link_codes_userId_idx" ON "telegram_link_codes"("userId");

-- CreateIndex
CREATE INDEX "runner_incidents_runnerId_resolvedAt_idx" ON "runner_incidents"("runnerId", "resolvedAt");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_mutes" ADD CONSTRAINT "notification_mutes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_mutes" ADD CONSTRAINT "notification_mutes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runner_incidents" ADD CONSTRAINT "runner_incidents_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
