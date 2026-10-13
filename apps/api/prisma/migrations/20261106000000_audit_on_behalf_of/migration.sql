-- AlterTable
-- Nullable, no default: no existing row is rewritten, so the append-only
-- trigger never fires and every stored hash stays valid (docs/specs/8 D1).
ALTER TABLE "audit_records" ADD COLUMN     "actorOnBehalfOfId" TEXT;

-- CreateIndex
CREATE INDEX "audit_records_actorOnBehalfOfId_ts_idx" ON "audit_records"("actorOnBehalfOfId", "ts");
