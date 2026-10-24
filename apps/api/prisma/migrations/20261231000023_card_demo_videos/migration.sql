-- CreateEnum
CREATE TYPE "CardDemoStatus" AS ENUM ('queued', 'recording', 'ready', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "CardDemoTrigger" AS ENUM ('auto', 'manual');

-- AlterTable
ALTER TABLE "board_settings" ADD COLUMN     "demoTelegram" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "demoUiPaths" TEXT[] DEFAULT ARRAY['apps/web/**', '**/*.tsx', '**/*.css']::TEXT[],
ADD COLUMN     "demoVideosEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "project_demo_secrets" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "valueCiphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "project_demo_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_demos" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "status" "CardDemoStatus" NOT NULL DEFAULT 'queued',
    "trigger" "CardDemoTrigger" NOT NULL,
    "reason" TEXT,
    "scenarioPath" TEXT,
    "attachmentId" TEXT,
    "durationMs" INTEGER,
    "size" INTEGER,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "card_demos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_demo_secrets_projectId_name_key" ON "project_demo_secrets"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "card_demos_attachmentId_key" ON "card_demos"("attachmentId");

-- CreateIndex
CREATE INDEX "card_demos_cardId_createdAt_idx" ON "card_demos"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "card_demos_status_idx" ON "card_demos"("status");

-- AddForeignKey
ALTER TABLE "project_demo_secrets" ADD CONSTRAINT "project_demo_secrets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_demo_secrets" ADD CONSTRAINT "project_demo_secrets_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_demos" ADD CONSTRAINT "card_demos_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_demos" ADD CONSTRAINT "card_demos_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_demos" ADD CONSTRAINT "card_demos_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
