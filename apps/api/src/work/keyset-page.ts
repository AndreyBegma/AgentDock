import type { Keyset } from '../activity/keyset';

/** A row of one source, keyed by `(updatedAt, id)`. */
export interface KeyedRow<T> {
  key: Keyset;
  item: T;
}

/**
 * What one source read for a page (L-25): its rows newest first, and — when
 * it stopped before its end — its horizon, the key of the last row it read.
 * Nothing of the source past the horizon is known.
 */
export interface SourceSlice<T> {
  rows: KeyedRow<T>[];
  horizon: Keyset | null;
}

/** How many reads of `size + 1` a source with a derived filter may make. */
export const SCAN_BATCHES = 8;

/** `(at, id)` descending: whether `a` comes after `b` — older, or the smaller id. */
export const keysetBefore = (a: Keyset, b: Keyset): boolean =>
  a.at.getTime() < b.at.getTime() ||
  (a.at.getTime() === b.at.getTime() && a.id < b.id);

/** The rows strictly after the cursor, for a model keyed by `(updatedAt, id)`. */
export const afterKeyset = (after: Keyset) => ({
  OR: [
    { updatedAt: { lt: after.at } },
    { updatedAt: after.at, id: { lt: after.id } },
  ],
});

/** The keyset order every source reads in. */
export const KEYSET_ORDER = [
  { updatedAt: 'desc' as const },
  { id: 'desc' as const },
];

/**
 * Reads a source in keyset order, `size + 1` rows at a time, until it has more
 * than a page of rows `map` keeps, it ends, or it has read `SCAN_BATCHES`
 * times. A source whose filter is in SQL stops after the first read; one whose
 * filter is derived after a join (a plan task's status) reads on, bounded.
 */
export const scanKeyset = async <R extends { id: string; updatedAt: Date }, T>(
  size: number,
  after: Keyset | null,
  read: (after: Keyset | null, take: number) => Promise<R[]>,
  map: (batch: R[]) => Promise<KeyedRow<T>[]>,
): Promise<SourceSlice<T>> => {
  const rows: KeyedRow<T>[] = [];
  let cursor = after;
  for (let i = 0; i < SCAN_BATCHES; i += 1) {
    const batch = await read(cursor, size + 1);
    rows.push(...(await map(batch)));
    const last = batch.at(-1);
    if (batch.length <= size || !last) return { rows, horizon: null };
    cursor = { at: last.updatedAt, id: last.id };
    if (rows.length > size) break;
  }
  return { rows, horizon: cursor };
};

/**
 * Merges the sources into one page of `size`, newest first. Rows past the
 * nearest horizon are dropped — a source that stopped there may hold rows
 * before them — and the page then ends at that horizon.
 */
export const mergeKeysetPage = <T>(
  sources: SourceSlice<T>[],
  size: number,
): { items: T[]; next: Keyset | null } => {
  let horizon: Keyset | null = null;
  for (const s of sources) {
    if (s.horizon && (!horizon || keysetBefore(horizon, s.horizon))) {
      horizon = s.horizon;
    }
  }
  const rows = sources
    .flatMap((s) => s.rows)
    .filter((r) => !horizon || !keysetBefore(r.key, horizon))
    .sort((a, b) =>
      keysetBefore(a.key, b.key) ? 1 : keysetBefore(b.key, a.key) ? -1 : 0,
    );
  if (rows.length > size) {
    const page = rows.slice(0, size);
    return {
      items: page.map((r) => r.item),
      next: page.at(-1)?.key ?? null,
    };
  }
  return { items: rows.map((r) => r.item), next: horizon };
};
