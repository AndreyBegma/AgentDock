-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('user', 'runner', 'system', 'anonymous');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('ok', 'denied', 'error', 'requested');

-- CreateTable
CREATE TABLE "audit_records" (
    "seq" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "AuditActorType" NOT NULL,
    "actorUserId" TEXT,
    "actorRunnerId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "projectId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "result" "AuditResult" NOT NULL,
    "meta" JSONB,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_records_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_records_hash_key" ON "audit_records"("hash");

-- CreateIndex
CREATE INDEX "audit_records_ts_idx" ON "audit_records"("ts");

-- CreateIndex
CREATE INDEX "audit_records_action_ts_idx" ON "audit_records"("action", "ts");

-- CreateIndex
CREATE INDEX "audit_records_actorUserId_ts_idx" ON "audit_records"("actorUserId", "ts");

-- CreateIndex
CREATE INDEX "audit_records_projectId_ts_idx" ON "audit_records"("projectId", "ts");

-- CreateIndex
CREATE INDEX "audit_records_targetType_targetId_idx" ON "audit_records"("targetType", "targetId");

-- Append-only (docs/specs/8 D3). Hand-written: Prisma has no trigger DSL.
CREATE FUNCTION audit_records_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_records is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_records_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_records
  FOR EACH ROW EXECUTE FUNCTION audit_records_immutable();

CREATE TRIGGER audit_records_no_truncate
  BEFORE TRUNCATE ON audit_records
  FOR EACH STATEMENT EXECUTE FUNCTION audit_records_immutable();
