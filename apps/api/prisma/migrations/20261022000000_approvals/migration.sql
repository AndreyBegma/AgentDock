-- CreateEnum
CREATE TYPE "ApprovalSource" AS ENUM ('orchestrator', 'derived');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('waiting', 'approved', 'changes_requested', 'stale', 'merged', 'closed');

-- CreateTable
CREATE TABLE "merge_approvals" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "slot" TEXT,
    "issue" INTEGER,
    "headSha" TEXT,
    "source" "ApprovalSource" NOT NULL,
    "status" "ApprovalStatus" NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "waitingSince" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merge_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merge_approvals_projectId_prNumber_idx" ON "merge_approvals"("projectId", "prNumber");

-- CreateIndex
CREATE INDEX "merge_approvals_projectId_status_idx" ON "merge_approvals"("projectId", "status");

-- AddForeignKey
ALTER TABLE "merge_approvals" ADD CONSTRAINT "merge_approvals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_approvals" ADD CONSTRAINT "merge_approvals_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
