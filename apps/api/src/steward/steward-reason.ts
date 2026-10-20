import { STEWARD_REASON_MAX } from '@nautelle/shared';

/**
 * C0 and C1 controls, DEL, and the Unicode format characters that reorder or
 * hide text: zero-width spaces and marks, line and paragraph separators,
 * bidi embeddings, overrides and isolates, word joiners, the BOM.
 */
const CONTROL_RANGES: readonly [number, number][] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

const isControl = (codePoint: number): boolean =>
  CONTROL_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);

/**
 * DA-13: a reason haiku or a rule wrote, as the API stores and sends it — one
 * line, no control or format characters, whitespace collapsed, at most
 * `STEWARD_REASON_MAX` characters. `null` when nothing printable is left.
 * Applied on intake, so every reader — Activity, the chip, a notification,
 * Telegram — gets the same safe line.
 */
export const sanitizeReason = (value: string): string | null => {
  const chars = [...value]
    .map((c) => (isControl(c.codePointAt(0) ?? 0) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (chars.length === 0) return null;
  const points = [...chars];
  return points.length > STEWARD_REASON_MAX
    ? `${points.slice(0, STEWARD_REASON_MAX - 1).join('')}…`
    : chars;
};
