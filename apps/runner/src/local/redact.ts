import { createHash } from 'node:crypto';
import { ACTION_REQUEST_TOOL_INPUT_MAX } from '@agentdock/shared';
import {
  HOOK_CONTENT_MAX_CHARS,
  type HookContent,
} from '@agentdock/shared/protocol';
import { redactText } from '../pane/redact';

/**
 * Hook content redaction (ADR-0021 §4, spec 201 D13) is the runner's one
 * redactor (`pane/redact.ts`, C-128); this module caps what it returns.
 */
export { redactText };

/**
 * Redacted and capped content. Redaction runs before the cut, so a secret
 * across the cap is masked rather than half kept; a text far above the cap
 * is cut to four times it first, which bounds the regex work.
 */
export const toHookContent = (
  text: string,
  alreadyTruncated = false,
  max = HOOK_CONTENT_MAX_CHARS,
): HookContent => {
  const pre = text.length > max * 4 ? text.slice(0, max * 4) : text;
  const redacted = redactText(pre);
  const truncated = alreadyTruncated || pre !== text || redacted.length > max;
  let cut = redacted.slice(0, max);
  // Never end on half a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: cut, truncated };
};

/** The redacted tool input of a `tool_use` request (C-114, D-08). */
export interface ToolInputPreview {
  input: string;
  truncated: boolean;
  fullLength: number;
  sha256: string;
}

const omittedMarker = (omitted: number): string =>
  `\n… [${omitted} characters omitted] …\n`;

/** A cut at `at` would split a surrogate pair. */
const splitsPair = (text: string, at: number): boolean =>
  /[\uD800-\uDBFF]/.test(text[at - 1] ?? '') &&
  /[\uDC00-\uDFFF]/.test(text[at] ?? '');

/**
 * The whole tool input, redacted, when it fits `max`; else its head and
 * tail with a marker between them, all three within `max` — the end of a
 * long command is where a harmful part hides. `fullLength` and `sha256`
 * describe the full redacted input, so a person can tell what they saw
 * from what was asked.
 */
export const toToolInputPreview = (
  raw: string,
  max = ACTION_REQUEST_TOOL_INPUT_MAX,
): ToolInputPreview => {
  const redacted = redactText(raw);
  const fullLength = redacted.length;
  const sha256 = createHash('sha256').update(redacted, 'utf8').digest('hex');
  if (fullLength <= max) {
    return { input: redacted, truncated: false, fullLength, sha256 };
  }
  // The marker for the full length is never shorter than the real one.
  const shown = Math.max(0, max - omittedMarker(fullLength).length);
  // A cut inside a surrogate pair moves outward: never over the budget.
  let headEnd = Math.ceil(shown / 2);
  if (splitsPair(redacted, headEnd)) headEnd -= 1;
  let tailStart = fullLength - (shown - headEnd);
  if (splitsPair(redacted, tailStart)) tailStart += 1;
  const input = `${redacted.slice(0, headEnd)}${omittedMarker(tailStart - headEnd)}${redacted.slice(tailStart)}`;
  return { input, truncated: true, fullLength, sha256 };
};
