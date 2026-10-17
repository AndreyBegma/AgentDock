-- CreateEnum
CREATE TYPE "LlmProvider" AS ENUM ('anthropic', 'openai', 'xai', 'openrouter');

-- CreateEnum
CREATE TYPE "LlmFeature" AS ENUM ('assistant', 'digest', 'summary', 'search', 'triage', 'title');

-- CreateEnum
CREATE TYPE "LlmCallOutcome" AS ENUM ('ok', 'error', 'aborted');

-- CreateTable
CREATE TABLE "llm_provider_settings" (
    "provider" "LlmProvider" NOT NULL,
    "keyCiphertext" TEXT,
    "keySuffix" TEXT,
    "keyUpdatedAt" TIMESTAMP(3),
    "capUsd" DECIMAL(12,2) NOT NULL,
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "llm_provider_settings_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "llm_calls" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "provider" "LlmProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "feature" "LlmFeature" NOT NULL,
    "outcome" "LlmCallOutcome" NOT NULL,
    "errorCode" TEXT,
    "input" INTEGER NOT NULL DEFAULT 0,
    "output" INTEGER NOT NULL DEFAULT 0,
    "cacheRead" INTEGER NOT NULL DEFAULT 0,
    "cacheWrite5m" INTEGER NOT NULL DEFAULT 0,
    "cacheWrite1h" INTEGER NOT NULL DEFAULT 0,
    "reasoning" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(14,6) NOT NULL,
    "priceVersion" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,

    CONSTRAINT "llm_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_calls_provider_ts_idx" ON "llm_calls"("provider", "ts");

-- CreateIndex
CREATE INDEX "llm_calls_ts_idx" ON "llm_calls"("ts");

-- AddForeignKey
ALTER TABLE "llm_provider_settings" ADD CONSTRAINT "llm_provider_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ADR-0057: Anthropic starts with a $200 monthly cap; every other provider at
-- 0, which is disabled until an admin sets a cap.
INSERT INTO "llm_provider_settings" ("provider", "capUsd", "updatedAt") VALUES
    ('anthropic', 200, CURRENT_TIMESTAMP),
    ('openai', 0, CURRENT_TIMESTAMP),
    ('xai', 0, CURRENT_TIMESTAMP),
    ('openrouter', 0, CURRENT_TIMESTAMP);
