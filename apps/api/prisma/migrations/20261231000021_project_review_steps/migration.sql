-- CreateEnum
CREATE TYPE "ReviewStepType" AS ENUM ('peer_review', 'skill');

-- AlterEnum
ALTER TYPE "LlmFeature" ADD VALUE 'review_instructions';

-- AlterTable
ALTER TABLE "board_settings" ADD COLUMN     "publishReviewComments" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "project_review_steps" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "name" TEXT NOT NULL,
    "type" "ReviewStepType" NOT NULL,
    "instructions" TEXT,
    "skillName" TEXT,
    "instructionsGeneratedAt" TIMESTAMP(3),
    "instructionsEditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_review_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_review_steps_projectId_position_idx" ON "project_review_steps"("projectId", "position");

-- #862: at most one peer review step per project. Prisma cannot express a
-- partial index, so it lives here only.
CREATE UNIQUE INDEX "project_review_steps_peer_review_key" ON "project_review_steps"("projectId")
WHERE "type" = 'peer_review';

-- AddForeignKey
ALTER TABLE "project_review_steps" ADD CONSTRAINT "project_review_steps_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
