-- CreateEnum
CREATE TYPE "QuerySource" AS ENUM ('main', 'subagent', 'auxiliary');

-- CreateEnum
CREATE TYPE "CostSource" AS ENUM ('computed', 'ingested');

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "runtime" "Runtime" NOT NULL,
    "profileKey" TEXT,
    "externalId" TEXT NOT NULL,
    "projectId" TEXT,
    "slotName" TEXT,
    "cwd" TEXT NOT NULL,
    "gitBranch" TEXT,
    "title" TEXT,
    "models" JSONB NOT NULL DEFAULT '[]',
    "parentSessionId" TEXT,
    "parsed" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turns" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_requests" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT,
    "requestId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "model" TEXT NOT NULL,
    "querySource" "QuerySource" NOT NULL,
    "input" INTEGER NOT NULL DEFAULT 0,
    "output" INTEGER NOT NULL DEFAULT 0,
    "cacheRead" INTEGER NOT NULL DEFAULT 0,
    "cacheWrite5m" INTEGER NOT NULL DEFAULT 0,
    "cacheWrite1h" INTEGER NOT NULL DEFAULT 0,
    "reasoning" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "durationApprox" BOOLEAN NOT NULL DEFAULT false,
    "stopReason" TEXT,
    "costUsd" DECIMAL(14,6),
    "priceVersion" INTEGER,
    "costSource" "CostSource",

    CONSTRAINT "llm_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_calls" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT,
    "toolUseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "ok" BOOLEAN,
    "childSessionId" TEXT,

    CONSTRAINT "tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_projectId_startedAt_idx" ON "sessions"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "sessions_parentSessionId_idx" ON "sessions"("parentSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_runnerId_runtime_externalId_key" ON "sessions"("runnerId", "runtime", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "turns_sessionId_promptId_key" ON "turns"("sessionId", "promptId");

-- CreateIndex
CREATE INDEX "llm_requests_ts_idx" ON "llm_requests"("ts");

-- CreateIndex
CREATE INDEX "llm_requests_model_ts_idx" ON "llm_requests"("model", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "llm_requests_sessionId_requestId_key" ON "llm_requests"("sessionId", "requestId");

-- CreateIndex
CREATE INDEX "tool_calls_childSessionId_idx" ON "tool_calls"("childSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "tool_calls_sessionId_toolUseId_key" ON "tool_calls"("sessionId", "toolUseId");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turns" ADD CONSTRAINT "turns_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_childSessionId_fkey" FOREIGN KEY ("childSessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
