-- #748: the manual session a /cs-eco stats row was read from.

-- AlterTable
ALTER TABLE "token_saver_stats" ADD COLUMN     "sessionExternalId" TEXT,
ADD COLUMN     "sessionId" TEXT;

-- CreateIndex
CREATE INDEX "token_saver_stats_sessionId_idx" ON "token_saver_stats"("sessionId");

-- CreateIndex
CREATE INDEX "token_saver_stats_projectId_sessionExternalId_idx" ON "token_saver_stats"("projectId", "sessionExternalId");

-- AddForeignKey
ALTER TABLE "token_saver_stats" ADD CONSTRAINT "token_saver_stats_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
