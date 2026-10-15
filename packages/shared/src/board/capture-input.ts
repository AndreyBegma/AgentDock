import type { SessionContentKind } from '../sessions/manual';
import {
  CAPTURE_INPUT_MAX_BYTES,
  CAPTURE_MIN_INPUT_CHARS,
  CAPTURE_PROMPT_HEAD_BYTES,
  CAPTURE_RESPONSE_TAIL_BYTES,
} from './capture-limits';

/**
 * D3 (issue #244): which session content an extraction reads. Only `prompt`
 * rows (their first `CAPTURE_PROMPT_HEAD_BYTES`) and `response` rows (their
 * last `CAPTURE_RESPONSE_TAIL_BYTES`), never tool input or output; only rows
 * after the session's watermark; newest first until `CAPTURE_INPUT_MAX_BYTES`.
 * Pure: the API loads the rows, this decides.
 */

/** A `session_contents` row as the API loads it. */
export interface CaptureContentRow {
  id: string | bigint;
  kind: SessionContentKind;
  text: string;
}

/** One piece of content in the prompt. */
export interface CaptureInputItem {
  /** Decimal string. */
  id: string;
  kind: 'prompt' | 'response';
  text: string;
  /** The text was cut to its head (prompt) or tail (response). */
  clipped: boolean;
}

export type CaptureInputSelection =
  | {
      ok: true;
      /** Oldest first, the order the prompt shows them in. */
      items: CaptureInputItem[];
      /** The oldest id in `items`. */
      contentFromId: string;
      /**
       * The newest eligible id after the watermark — the next watermark. Rows
       * older than the budget reached are passed over, never sent later.
       */
      contentToId: string;
      /** Characters of `items` text. */
      inputChars: number;
    }
  | {
      ok: false;
      /** Under `CAPTURE_MIN_INPUT_CHARS`: skip, and keep the watermark so the content waits for more. */
      reason: 'too_little';
      inputChars: number;
    };

const utf8Length = (codePoint: number): number =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

export const utf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (const char of text) bytes += utf8Length(char.codePointAt(0) ?? 0);
  return bytes;
};

/** The longest prefix of `text` within `max` UTF-8 bytes; never splits a code point. */
export const headBytes = (text: string, max: number): string => {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += utf8Length(char.codePointAt(0) ?? 0);
    if (bytes > max) break;
    end += char.length;
  }
  return text.slice(0, end);
};

/** The longest suffix of `text` within `max` UTF-8 bytes; never splits a code point. */
export const tailBytes = (text: string, max: number): string => {
  const chars = Array.from(text);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const next = bytes + utf8Length(chars[start - 1].codePointAt(0) ?? 0);
    if (next > max) break;
    bytes = next;
    start--;
  }
  return chars.slice(start).join('');
};

const toBigInt = (id: string | bigint): bigint =>
  typeof id === 'bigint' ? id : BigInt(id);

const clip = (row: CaptureContentRow & { kind: 'prompt' | 'response' }) => {
  const text =
    row.kind === 'prompt'
      ? headBytes(row.text, CAPTURE_PROMPT_HEAD_BYTES)
      : tailBytes(row.text, CAPTURE_RESPONSE_TAIL_BYTES);
  return { text, clipped: text.length < row.text.length };
};

/**
 * Picks an extraction's content from `rows` (any order, any kind). `watermark`
 * is the session's last `card_captures.contentToId`, `null` before the first.
 */
export const selectCaptureInput = (
  rows: readonly CaptureContentRow[],
  watermark: string | bigint | null,
): CaptureInputSelection => {
  const after = watermark === null ? null : toBigInt(watermark);
  const eligible = rows
    .filter(
      (row): row is CaptureContentRow & { kind: 'prompt' | 'response' } =>
        (row.kind === 'prompt' || row.kind === 'response') &&
        (after === null || toBigInt(row.id) > after),
    )
    .sort((a, b) => {
      const d = toBigInt(b.id) - toBigInt(a.id);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });

  const newestFirst: CaptureInputItem[] = [];
  let bytes = 0;
  for (const row of eligible) {
    const { text, clipped } = clip(row);
    if (text.trim() === '') continue;
    const size = utf8ByteLength(text);
    if (bytes + size > CAPTURE_INPUT_MAX_BYTES) break;
    bytes += size;
    newestFirst.push({ id: String(row.id), kind: row.kind, text, clipped });
  }

  const inputChars = newestFirst.reduce((n, item) => n + item.text.length, 0);
  if (newestFirst.length === 0 || inputChars < CAPTURE_MIN_INPUT_CHARS) {
    return { ok: false, reason: 'too_little', inputChars };
  }
  const items = newestFirst.reverse();
  return {
    ok: true,
    items,
    contentFromId: items[0].id,
    contentToId: String(eligible[0].id),
    inputChars,
  };
};
