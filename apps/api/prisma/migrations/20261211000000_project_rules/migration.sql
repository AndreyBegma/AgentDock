-- CreateEnum
CREATE TYPE "ProjectRuleSource" AS ENUM ('manual', 'imported', 'scanned');

-- CreateTable
CREATE TABLE "project_rules" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "source" "ProjectRuleSource" NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_rules_projectId_position_idx" ON "project_rules"("projectId", "position");

-- AddForeignKey
ALTER TABLE "project_rules" ADD CONSTRAINT "project_rules_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

