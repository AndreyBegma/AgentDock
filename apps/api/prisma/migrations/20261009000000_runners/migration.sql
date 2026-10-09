-- CreateEnum
CREATE TYPE "Runtime" AS ENUM ('claude', 'codex');

-- CreateTable
CREATE TABLE "runners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT,
    "version" TEXT,
    "protocolVersion" INTEGER,
    "os" TEXT,
    "arch" TEXT,
    "capabilities" JSONB,
    "tokenHash" TEXT,
    "tokenPrefix" TEXT,
    "ackedSeq" BIGINT NOT NULL DEFAULT 0,
    "pairedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runner_pairing_codes" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runner_pairing_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_profiles" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "runtime" "Runtime" NOT NULL,
    "label" TEXT NOT NULL,
    "binary" TEXT,
    "env" JSONB NOT NULL,
    "args" JSONB NOT NULL,
    "authenticated" BOOLEAN NOT NULL,
    "missing" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runtime_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" BIGSERIAL NOT NULL,
    "runnerId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "projectRepo" TEXT,
    "projectRoot" TEXT,
    "slot" TEXT,
    "issue" INTEGER,
    "session" JSONB,
    "data" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "runners_tokenPrefix_key" ON "runners"("tokenPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "runner_pairing_codes_codeHash_key" ON "runner_pairing_codes"("codeHash");

-- CreateIndex
CREATE INDEX "runner_pairing_codes_runnerId_idx" ON "runner_pairing_codes"("runnerId");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_profiles_runnerId_key_key" ON "runtime_profiles"("runnerId", "key");

-- CreateIndex
CREATE INDEX "events_type_ts_idx" ON "events"("type", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "events_runnerId_seq_key" ON "events"("runnerId", "seq");

-- AddForeignKey
ALTER TABLE "runners" ADD CONSTRAINT "runners_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runner_pairing_codes" ADD CONSTRAINT "runner_pairing_codes_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
