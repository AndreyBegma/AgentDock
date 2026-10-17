-- C-137 L-06: a plugin event is unique per runner and project root, so two
-- runners watching the same root no longer drop each other's events.
DROP INDEX "events_projectRoot_pluginEventId_key";

-- CreateIndex
CREATE UNIQUE INDEX "events_runnerId_projectRoot_pluginEventId_key" ON "events"("runnerId", "projectRoot", "pluginEventId");
