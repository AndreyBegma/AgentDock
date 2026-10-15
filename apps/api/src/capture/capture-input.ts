import {
  buildCapturePrompt,
  type CaptureContentRow,
  type CaptureInputSelection,
  selectCaptureInput,
} from '@agentdock/shared';

/**
 * Content rows loaded per extraction, newest first, after the watermark. The
 * input holds at most `CAPTURE_INPUT_MAX_BYTES` and every row adds at least a
 * byte, but rows of whitespace add nothing; this bounds the read.
 */
export const CAPTURE_ROWS_MAX = 2000;

export type CaptureInput =
  | {
      ok: true;
      selection: Extract<CaptureInputSelection, { ok: true }>;
      prompt: string;
    }
  | Extract<CaptureInputSelection, { ok: false }>;

/**
 * D3 (issue #244): what one extraction sends. `rows` are the session's
 * content rows (any kind — tool rows are dropped by the selection);
 * `watermark` is the session's last `contentToId`, `null` before the first;
 * `openCardTitles` are the project's open cards, newest first.
 */
export const prepareCaptureInput = (
  rows: readonly CaptureContentRow[],
  watermark: bigint | null,
  openCardTitles: readonly string[],
): CaptureInput => {
  const selection = selectCaptureInput(rows, watermark);
  if (!selection.ok) return selection;
  return {
    ok: true,
    selection,
    prompt: buildCapturePrompt(selection.items, openCardTitles),
  };
};
