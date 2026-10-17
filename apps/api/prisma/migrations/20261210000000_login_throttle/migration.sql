-- C-109: no hard per-account lock any more; failures are counted per (email, IP).
-- AlterTable
ALTER TABLE "users" DROP COLUMN "failedLoginCount",
DROP COLUMN "lockedUntil";

-- CreateTable
CREATE TABLE "login_throttles" (
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "failures" INTEGER NOT NULL,
    "lastFailureAt" TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3),

    CONSTRAINT "login_throttles_pkey" PRIMARY KEY ("email","ip")
);

-- CreateTable
CREATE TABLE "audit_folds" (
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "minute" TIMESTAMP(3) NOT NULL,
    "actor" JSONB NOT NULL,
    "result" "AuditResult" NOT NULL,
    "userAgent" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,
    "reasons" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_folds_pkey" PRIMARY KEY ("action","targetType","targetId","ip","minute")
);

-- CreateIndex
CREATE INDEX "login_throttles_lastFailureAt_idx" ON "login_throttles"("lastFailureAt");

-- CreateIndex
CREATE INDEX "audit_folds_minute_idx" ON "audit_folds"("minute");
