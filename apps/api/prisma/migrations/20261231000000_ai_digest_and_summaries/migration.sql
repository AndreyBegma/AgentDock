-- #658: the daily AI digest (settings and occurrences) and cached card and session summaries.
-- CreateEnum
CREATE TYPE "AiDigestStatus" AS ENUM ('pending', 'sent', 'skipped');

-- CreateEnum
CREATE TYPE "AiSummarySubject" AS ENUM ('card', 'session');

-- CreateTable
CREATE TABLE "ai_digest_settings" (
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "time" TEXT NOT NULL DEFAULT '09:00',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_digest_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "ai_digests" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "AiDigestStatus" NOT NULL,
    "from" TIMESTAMP(3) NOT NULL,
    "to" TIMESTAMP(3) NOT NULL,
    "content" JSONB,
    "overview" TEXT,
    "provider" "LlmProvider",
    "model" TEXT,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_digests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_summaries" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "subject" "AiSummarySubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "provider" "LlmProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "costUsd" DECIMAL(14,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_digests_projectId_createdAt_idx" ON "ai_digests"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_digests_projectId_dueAt_key" ON "ai_digests"("projectId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_summaries_subject_subjectId_language_key" ON "ai_summaries"("subject", "subjectId", "language");

-- AddForeignKey
ALTER TABLE "ai_digest_settings" ADD CONSTRAINT "ai_digest_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_digest_settings" ADD CONSTRAINT "ai_digest_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_digests" ADD CONSTRAINT "ai_digests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
