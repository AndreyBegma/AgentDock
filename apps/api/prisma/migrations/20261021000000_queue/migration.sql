-- CreateEnum
CREATE TYPE "IssueKind" AS ENUM ('issue', 'pull_request');

-- CreateEnum
CREATE TYPE "IssueState" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "IssueClosedBy" AS ENUM ('pr', 'manual');

-- CreateEnum
CREATE TYPE "QueueState" AS ENUM ('in_flight', 'ready', 'blocked_work', 'blocked_person', 'no_spec');

-- CreateEnum
CREATE TYPE "QueueStateSource" AS ENUM ('computed', 'orchestrator');

-- CreateTable
CREATE TABLE "issues_cache" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "IssueKind" NOT NULL DEFAULT 'issue',
    "title" TEXT NOT NULL,
    "state" "IssueState" NOT NULL,
    "labels" JSONB NOT NULL,
    "assignees" JSONB NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "ghUpdatedAt" TIMESTAMP(3) NOT NULL,
    "closedBy" "IssueClosedBy",
    "closingPr" INTEGER,
    "closedAt" TIMESTAMP(3),
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "lastSeq" BIGINT NOT NULL,

    CONSTRAINT "issues_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_states" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "state" "QueueState" NOT NULL,
    "why" TEXT NOT NULL,
    "clears" TEXT,
    "source" "QueueStateSource" NOT NULL,
    "orchestratorState" "QueueState",
    "orchestratorWhy" TEXT,
    "orchestratorClears" TEXT,
    "blockers" JSONB NOT NULL,
    "waveSlots" JSONB,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_feeds" (
    "projectId" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3),
    "snapshotId" TEXT,
    "unavailableReason" TEXT,
    "unavailableAt" TIMESTAMP(3),
    "lastSeq" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_feeds_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE INDEX "issues_cache_projectId_state_idx" ON "issues_cache"("projectId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "issues_cache_projectId_number_key" ON "issues_cache"("projectId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "queue_states_projectId_issueNumber_key" ON "queue_states"("projectId", "issueNumber");

-- AddForeignKey
ALTER TABLE "issues_cache" ADD CONSTRAINT "issues_cache_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_states" ADD CONSTRAINT "queue_states_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_feeds" ADD CONSTRAINT "issue_feeds_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
