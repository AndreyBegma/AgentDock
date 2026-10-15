/**
 * The canonical filter bar's state (#213): every filter lives in the URL, so
 * reload, back and a shared link all keep it. A page describes its filters
 * once — how to read them from the query string and how to write them back —
 * and `useUrlFilters` does the routing. Pure, so the rules are tested without
 * a router.
 */

/** How a page's filters are read from and written to the query string. */
export interface FilterCodec<F> {
  /** The query keys the codec owns; every other key is left as it is. */
  keys: readonly string[];
  parse: (params: URLSearchParams) => F;
  /** `''` or `?…` — only the codec's own keys. */
  search: (filters: F) => string;
}

/**
 * The query string after writing `own` (a codec's `search`) over `current`:
 * the codec's keys are replaced as a whole, a key it does not own — a tab,
 * an open panel — is kept. `''` or `?…`.
 */
export function mergeSearch(
  current: string,
  keys: readonly string[],
  own: string,
): string {
  const params = new URLSearchParams(current);
  for (const key of keys) params.delete(key);
  for (const [key, value] of new URLSearchParams(own)) {
    params.append(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** One filter the page can show as a removable chip. */
export interface ChipDef<F> {
  key: string;
  /** The chip's text, or null while the filter is not set. */
  label: (filters: F) => string | null;
  /** What removing the chip writes. */
  clear: Partial<F>;
}

/** One chip of the `Toolbar`'s `activeFilters`, without its handler. */
export interface ActiveChip<F> {
  key: string;
  label: string;
  clear: Partial<F>;
}

/** The filters in force, in the page's order. */
export function activeChips<F>(
  filters: F,
  defs: readonly ChipDef<F>[],
): ActiveChip<F>[] {
  const chips: ActiveChip<F>[] = [];
  for (const def of defs) {
    const label = def.label(filters);
    if (label !== null) chips.push({ key: def.key, label, clear: def.clear });
  }
  return chips;
}

/** What "Clear all" writes: every chip's `clear`, merged. */
export function clearAll<F>(defs: readonly ChipDef<F>[]): Partial<F> {
  return Object.assign({}, ...defs.map((def) => def.clear));
}

/** How long a typed search waits before it becomes a filter. */
export const SEARCH_DEBOUNCE_MS = 300;
