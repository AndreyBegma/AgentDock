/**
 * The shape of a row id (a cuid, or a uuid in older tables): letters, digits,
 * `_` and `-`. An id read from the URL is checked against it before any
 * request uses it, so a crafted link cannot carry `../` or `%2F` (C-165).
 */
const ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isEntityId = (value: string): boolean => ENTITY_ID.test(value);

/** `value` when it is an id, otherwise `undefined`. */
export const entityIdOrUndefined = (
  value: string | null | undefined,
): string | undefined =>
  value !== null && value !== undefined && isEntityId(value)
    ? value
    : undefined;
