/**
 * #497: a face's control is a 44 px touch target on a coarse pointer
 * (`--size-tap`, glass-ui's `Button` reads it too) and exactly what is drawn
 * on a fine one. The box grows around its content, so the drawn text, chip or
 * pill keeps its size and the desktop face keeps every pixel.
 */
export const TAP =
  'pointer-coarse:inline-flex pointer-coarse:min-h-(--size-tap) pointer-coarse:min-w-(--size-tap) pointer-coarse:items-center';

/** A face row that holds a 44 px control on a coarse pointer, so its hit area stays inside the row. */
export const TAP_ROW = 'pointer-coarse:min-h-(--size-tap)';
