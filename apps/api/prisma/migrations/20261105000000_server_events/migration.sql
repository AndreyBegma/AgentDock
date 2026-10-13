-- ADR-0014: server-originated events live in `events`.

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "events_source_dedupeKey_key" ON "events"("source", "dedupeKey");

-- Every server-originated row (`github.*` of spec 27 D9, `schedule.*` of
-- spec 25 D17) takes `seq = -nextval('server_event_seq')`. One sequence for
-- all of them: two would hand the same negative seq to rows of one runner and
-- collide on `(runnerId, seq)`. Runner seqs are positive and the ack cursor
-- only reads `seq > ackedSeq >= 0`, so the two never meet.
ALTER SEQUENCE "github_event_seq" RENAME TO "server_event_seq";
