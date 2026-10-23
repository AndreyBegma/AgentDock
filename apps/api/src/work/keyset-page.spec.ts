import type { Keyset } from '../activity/keyset';
import {
  keysetBefore,
  mergeKeysetPage,
  SCAN_BATCHES,
  type SourceSlice,
  scanKeyset,
} from './keyset-page';

const key = (minute: number, id = `id${minute}`): Keyset => ({
  at: new Date(Date.UTC(2026, 9, 15, 10, minute)),
  id,
});

/** A source of `count` rows, one a minute, newest first. */
const source = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, i) => {
    const k = key(count - 1 - i, `${prefix}${String(count - 1 - i)}`);
    return { id: k.id, updatedAt: k.at };
  });

/** Reads `rows` the way the SQL does, counting every row read. */
const reader = (rows: { id: string; updatedAt: Date }[]) => {
  const stats = { reads: 0, rows: 0 };
  const read = async (after: Keyset | null, take: number) => {
    const out = rows
      .filter(
        (r) => !after || keysetBefore({ at: r.updatedAt, id: r.id }, after),
      )
      .slice(0, take);
    stats.reads += 1;
    stats.rows += out.length;
    return out;
  };
  return { read, stats };
};

const keep =
  (pred: (id: string) => boolean) =>
  async (batch: { id: string; updatedAt: Date }[]) =>
    batch
      .filter((r) => pred(r.id))
      .map((r) => ({ key: { at: r.updatedAt, id: r.id }, item: r.id }));

/** L-25: a source reads a page plus one, a derived filter reads on, bounded. */
describe('scanKeyset', () => {
  it('reads a page plus one when every row is kept', async () => {
    const { read, stats } = reader(source(5000, 'a'));
    const slice = await scanKeyset(
      50,
      null,
      read,
      keep(() => true),
    );
    expect(stats).toEqual({ reads: 1, rows: 51 });
    expect(slice.rows).toHaveLength(51);
    expect(slice.horizon).toEqual(key(5000 - 51, 'a4949'));
  });

  it('ends without a horizon when the source runs out', async () => {
    const { read } = reader(source(10, 'a'));
    const slice = await scanKeyset(
      50,
      null,
      read,
      keep(() => true),
    );
    expect(slice.rows).toHaveLength(10);
    expect(slice.horizon).toBeNull();
  });

  it('stops a rare filter after SCAN_BATCHES reads, at its horizon', async () => {
    const { read, stats } = reader(source(5000, 'a'));
    const slice = await scanKeyset(
      50,
      null,
      read,
      keep(() => false),
    );
    expect(stats.reads).toBe(SCAN_BATCHES);
    expect(stats.rows).toBe(SCAN_BATCHES * 51);
    expect(slice.rows).toEqual([]);
    expect(slice.horizon).toEqual(
      key(5000 - SCAN_BATCHES * 51, `a${5000 - SCAN_BATCHES * 51}`),
    );
  });
});

describe('mergeKeysetPage', () => {
  const slice = (
    minutes: number[],
    prefix: string,
    horizon: Keyset | null = null,
  ): SourceSlice<string> => ({
    rows: minutes.map((m) => ({
      key: key(m, `${prefix}${m}`),
      item: `${prefix}${m}`,
    })),
    horizon,
  });

  it('interleaves the sources, newest first, and cuts a page', () => {
    const page = mergeKeysetPage(
      [slice([9, 7, 5, 3], 'a'), slice([8, 6, 4], 'b')],
      4,
    );
    expect(page.items).toEqual(['a9', 'b8', 'a7', 'b6']);
    expect(page.next).toEqual(key(6, 'b6'));
  });

  it('ends without a cursor when every source is read to its end', () => {
    const page = mergeKeysetPage([slice([3], 'a'), slice([2], 'b')], 4);
    expect(page.items).toEqual(['a3', 'b2']);
    expect(page.next).toBeNull();
  });

  it('drops rows past a source horizon and continues from it', () => {
    // `b` stopped at minute 6: rows of `a` older than that wait their turn.
    const page = mergeKeysetPage(
      [slice([9, 5, 3], 'a'), slice([8], 'b', key(6, 'b6'))],
      4,
    );
    expect(page.items).toEqual(['a9', 'b8']);
    expect(page.next).toEqual(key(6, 'b6'));
  });

  it('pages through a sparse filter without a gap', async () => {
    // Every 300th row of 5000 is kept: pages end at horizons, then go on.
    const all = source(5000, 'a');
    const { read } = reader(all);
    const pick = (id: string) => Number(id.slice(1)) % 300 === 0;
    const seen: string[] = [];
    let after: Keyset | null = null;
    for (let i = 0; i < 100; i += 1) {
      const s: SourceSlice<string> = await scanKeyset(
        50,
        after,
        read,
        keep(pick),
      );
      const page = mergeKeysetPage([s], 50);
      seen.push(...page.items);
      after = page.next;
      if (!after) break;
    }
    expect(seen).toEqual(all.map((r) => r.id).filter(pick));
  });
});
