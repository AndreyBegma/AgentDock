/** What a section shows (rule R2): never an error rendered as "no data". */
export type SectionView = 'loading' | 'unavailable' | 'empty' | 'ready';

export interface SectionState<T> {
  /** The last data that loaded; an error keeps it, never clears it. */
  data: T | undefined;
  /** The last load's failure; null once a load succeeds. */
  error: unknown;
  loading: boolean;
}

/**
 * The state to render. Data on screen wins over a spinner; a failure with no
 * data is `unavailable`, never `empty`. A failure with data still renders the
 * data — the caller shows `SectionUnavailable` above it.
 */
export function sectionView<T>(
  { data, error, loading }: SectionState<T>,
  isEmpty: (data: T) => boolean = defaultIsEmpty,
): SectionView {
  if (data === undefined) {
    if (error !== null && !loading) return 'unavailable';
    return 'loading';
  }
  return isEmpty(data) ? 'empty' : 'ready';
}

const defaultIsEmpty = (data: unknown): boolean =>
  Array.isArray(data) ? data.length === 0 : data === null;
