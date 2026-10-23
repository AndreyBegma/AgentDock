-- CreateEnum
CREATE TYPE "DesignTemplateChoice" AS ENUM ('auto', 'person');

-- CreateEnum
CREATE TYPE "DesignFrameKind" AS ENUM ('screen', 'breakdown', 'states', 'in_context', 'anatomy', 'state_grid', 'flow_map', 'flow_step', 'mobile', 'custom', 'legacy');

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "designTemplate" TEXT,
ADD COLUMN     "designTemplateSource" "DesignTemplateChoice" NOT NULL DEFAULT 'auto';

-- AlterTable
ALTER TABLE "design_frames" ADD COLUMN     "kind" "DesignFrameKind" NOT NULL DEFAULT 'legacy',
ADD COLUMN     "templateFrameKey" TEXT;

-- AlterTable
ALTER TABLE "design_revisions" ADD COLUMN     "conformance" JSONB,
ADD COLUMN     "repairTurnId" TEXT,
ADD COLUMN     "templateKey" TEXT;

-- AlterTable
ALTER TABLE "task_designs" ADD COLUMN     "templateKey" TEXT,
ADD COLUMN     "templateSource" "DesignTemplateChoice" NOT NULL DEFAULT 'auto';

-- CreateTable
CREATE TABLE "design_templates" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "design_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "design_templates_projectId_key_key" ON "design_templates"("projectId", "key");

-- AddForeignKey
ALTER TABLE "design_templates" ADD CONSTRAINT "design_templates_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_templates" ADD CONSTRAINT "design_templates_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
