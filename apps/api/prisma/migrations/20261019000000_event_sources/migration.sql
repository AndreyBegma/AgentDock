-- AlterTable
ALTER TABLE "events" ADD COLUMN     "pluginEventId" TEXT;

-- AlterTable
ALTER TABLE "rounds" ADD COLUMN     "sources" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "slots" ADD COLUMN     "sources" JSONB NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE INDEX "events_projectRoot_source_receivedAt_idx" ON "events"("projectRoot", "source", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "events_projectRoot_pluginEventId_key" ON "events"("projectRoot", "pluginEventId");
