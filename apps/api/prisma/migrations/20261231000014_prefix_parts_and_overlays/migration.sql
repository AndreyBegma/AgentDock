-- CreateEnum
CREATE TYPE "PrefixOverlayState" AS ENUM ('proposed', 'approved', 'rejected', 'stale');

-- AlterEnum
ALTER TYPE "RunKind" ADD VALUE 'rules_compress';
ALTER TYPE "RunKind" ADD VALUE 'prefix_propose';

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "sessionCardType" TEXT,
ADD COLUMN     "sessionPrefix" JSONB;

-- AlterTable
ALTER TABLE "project_rules" ADD COLUMN     "appliesTo" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "cardType" TEXT,
ADD COLUMN     "prefixTokens" INTEGER;

-- AlterTable
ALTER TABLE "token_saver_settings" ADD COLUMN     "mcpByType" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "prefixBudgetTokens" INTEGER NOT NULL DEFAULT 25000,
ADD COLUMN     "skillsOffByType" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "run_prefix_parts" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "launchKind" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '',
    "origin" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "estTokens" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_prefix_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prefix_overlays" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "part" TEXT NOT NULL,
    "originalSha256" TEXT NOT NULL,
    "originalBytes" INTEGER NOT NULL,
    "originalText" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "state" "PrefixOverlayState" NOT NULL DEFAULT 'proposed',
    "runId" TEXT,
    "rulesVersion" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "pullRequestCardId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prefix_overlays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_prefix_parts_projectId_createdAt_idx" ON "run_prefix_parts"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "run_prefix_parts_runId_idx" ON "run_prefix_parts"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "run_prefix_parts_runId_kind_name_key" ON "run_prefix_parts"("runId", "kind", "name");

-- CreateIndex
CREATE INDEX "prefix_overlays_projectId_part_idx" ON "prefix_overlays"("projectId", "part");

-- CreateIndex
-- #751 B7: at most one open overlay per part. Prisma cannot express a
-- partial index, so it lives here only.
CREATE UNIQUE INDEX "prefix_overlays_open_part_key" ON "prefix_overlays"("projectId", "part")
WHERE "state" IN ('proposed', 'approved');

-- AddForeignKey
ALTER TABLE "run_prefix_parts" ADD CONSTRAINT "run_prefix_parts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_prefix_parts" ADD CONSTRAINT "run_prefix_parts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prefix_overlays" ADD CONSTRAINT "prefix_overlays_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prefix_overlays" ADD CONSTRAINT "prefix_overlays_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
