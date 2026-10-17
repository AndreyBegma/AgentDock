-- AlterTable
ALTER TABLE "telegram_links" ADD COLUMN     "currentProjectId" TEXT;

-- CreateIndex
CREATE INDEX "telegram_links_currentProjectId_idx" ON "telegram_links"("currentProjectId");

-- AddForeignKey
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_currentProjectId_fkey" FOREIGN KEY ("currentProjectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
