/**
 * An opaque keyset cursor over `(time DESC, id DESC)` (spec 21 D11): the last
 * row of the previous page. New rows inserted at the top never shift a page.
 */
export interface Keyset {
  at: Date;
  id: string;
}

export const encodeKeyset = (key: Keyset): string =>
  Buffer.from(`${key.at.toISOString()}|${key.id}`).toString('base64url');

/** null for a cursor this API did not hand out. */
export const decodeKeyset = (cursor: string): Keyset | null => {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const bar = raw.indexOf('|');
  if (bar < 0) return null;
  const at = new Date(raw.slice(0, bar));
  const id = raw.slice(bar + 1);
  if (Number.isNaN(at.getTime()) || id === '' || id.length > 64) return null;
  return { at, id };
};
