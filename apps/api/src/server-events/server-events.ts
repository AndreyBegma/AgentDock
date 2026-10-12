import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * The next `seq` of a server-originated `events` row (ADR-0014): the negation
 * of `server_event_seq`. Runner seqs are positive and the ack cursor reads only
 * `seq > ackedSeq >= 0`, so the two never meet; one sequence for every server
 * source keeps them apart from each other on `(runnerId, seq)`.
 */
export const nextServerEventSeq = async (tx: Tx): Promise<bigint> => {
  const [{ seq }] = await tx.$queryRaw<{ seq: bigint }[]>`
    SELECT -nextval('server_event_seq') AS seq`;
  return seq;
};

/** The project a server-originated event is about — its anchor in `events`. */
export interface ServerEventProject {
  runnerId: string;
  rootPath: string;
  repo: string;
}

export interface ServerEventInput {
  /** `source` of the row, e.g. `api` (spec 25 D17). */
  source: string;
  type: string;
  ts: Date;
  project: ServerEventProject;
  data: Prisma.InputJsonObject;
  /** One row per `(source, dedupeKey)`. */
  dedupeKey: string;
}

/**
 * Records one server-originated event in `events` (ADR-0014), anchored on its
 * project's runner, inside the caller's transaction — the one that makes the
 * change it reports, so the two commit together. Returns false when a row
 * with the key already exists. The key is looked up first: a conflicting
 * insert would still burn an `events.id`, and the activity projector waits on
 * every hole in `id` before it passes it (spec 21 notes).
 */
export const recordServerEvent = async (
  tx: Tx,
  input: ServerEventInput,
): Promise<boolean> => {
  const existing = await tx.event.findUnique({
    where: {
      source_dedupeKey: { source: input.source, dedupeKey: input.dedupeKey },
    },
    select: { id: true },
  });
  if (existing) return false;
  const seq = await nextServerEventSeq(tx);
  // A concurrent writer of the same key loses quietly on the unique index.
  const { count } = await tx.event.createMany({
    data: [
      {
        runnerId: input.project.runnerId,
        seq,
        ts: input.ts,
        type: input.type,
        source: input.source,
        projectRoot: input.project.rootPath,
        projectRepo: input.project.repo,
        data: input.data,
        dedupeKey: input.dedupeKey,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
};
