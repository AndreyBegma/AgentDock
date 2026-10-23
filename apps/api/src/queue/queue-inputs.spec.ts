import type { Prisma } from '@prisma/client';
import { loadQueueInputs } from './queue-inputs';
import { computeQueue } from './queue-state';

type Db = Parameters<typeof loadQueueInputs>[0];

interface Row {
  number: number;
  kind: 'issue' | 'pull_request';
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  body: string;
  closedBy: 'pr' | 'manual' | null;
  snapshotAt: Date;
}

/**
 * A database of `issues_cache` rows that answers `findMany` with the columns
 * selected, recording each read's select and how many bodies it returned.
 */
const fakeDb = (rows: Row[]) => {
  const reads: {
    select: Prisma.IssueCacheSelect | null | undefined;
    bodies: number;
  }[] = [];
  const db = {
    project: {
      findUnique: async () => ({
        readyLabelOverride: null,
        codeSentinelConfig: null,
      }),
    },
    slot: { findMany: async () => [] },
    round: { findFirst: async () => null },
    issueCache: {
      findMany: async (args: Prisma.IssueCacheFindManyArgs) => {
        const numbers = (args.where?.number as { in?: number[] } | undefined)
          ?.in;
        const picked = rows.filter(
          (r) => !numbers || numbers.includes(r.number),
        );
        const select = args.select;
        const out = picked.map((r) =>
          select
            ? Object.fromEntries(
                Object.entries(r).filter(
                  ([k]) => select[k as keyof Prisma.IssueCacheSelect],
                ),
              )
            : r,
        );
        reads.push({
          select,
          bodies: out.filter((r) => 'body' in r).length,
        });
        return out;
      },
    },
  };
  return { db: db as unknown as Db, reads };
};

const at = new Date('2026-10-15T10:00:00Z');
const row = (number: number, over: Partial<Row> = {}): Row => ({
  number,
  kind: 'issue',
  title: `#${number}`,
  state: 'closed',
  labels: [],
  body: `Body of #${number}`,
  closedBy: 'pr',
  snapshotAt: at,
  ...over,
});

/** L-25: the recompute reads a body only where the queue needs it. */
describe('loadQueueInputs', () => {
  it('selects body only for open pull requests and ready issues', async () => {
    const rows = [
      ...Array.from({ length: 5000 }, (_, i) => row(i + 1)),
      row(6001, {
        state: 'open',
        labels: ['cs:ready'],
        body: 'Depends on #7\n',
      }),
      row(6002, { state: 'open', labels: ['bug'] }),
      row(6003, { kind: 'pull_request', state: 'open', body: 'Closes #6001' }),
      row(6004, { kind: 'pull_request', state: 'closed' }),
    ];
    const { db, reads } = fakeDb(rows);
    const inputs = await loadQueueInputs(db, 'p1');
    if (!inputs) throw new Error('no inputs');

    expect(reads).toHaveLength(2);
    expect(reads[0].select?.body).toBeUndefined();
    expect(reads[0].bodies).toBe(0);
    expect(reads[1].bodies).toBe(2);
    const bodies = new Map(inputs.issues.map((i) => [i.number, i.body]));
    expect(bodies.get(6001)).toBe('Depends on #7\n');
    expect(bodies.get(6003)).toBe('Closes #6001');
    expect(bodies.get(6002)).toBe('');
    expect(bodies.get(1)).toBe('');

    // The verdict is the one the full rows give.
    const full = { ...inputs, issues: rows.map((r) => ({ ...r })) };
    expect(computeQueue(inputs)).toEqual(computeQueue(full));
    expect(computeQueue(inputs)[0].computed.state).toBe('in_flight');
  });

  it('makes no second read when nothing needs a body', async () => {
    const { db, reads } = fakeDb([row(1), row(2, { state: 'open' })]);
    await loadQueueInputs(db, 'p1');
    expect(reads).toHaveLength(1);
  });
});
