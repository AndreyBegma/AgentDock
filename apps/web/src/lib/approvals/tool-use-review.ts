import type { ActionRequestSummary } from '@nautelle/shared';
import { toolUseArgs } from './action-requests';

/** What the runner puts where it masked a secret (`pane/redact.ts`). */
export const REDACTION_MASK = '•••';

/** One run of an input, shown as text or as a visible marker. */
export type InputSegment =
  | { kind: 'text'; text: string }
  | { kind: 'marker'; label: string }
  | { kind: 'redacted' };

/** Names for the characters that read as nothing, or reorder what is around them. */
const NAMED: Record<number, string> = {
  173: 'SHY',
  1564: 'ALM',
  6158: 'MVS',
  8203: 'ZWSP',
  8204: 'ZWNJ',
  8205: 'ZWJ',
  8206: 'LRM',
  8207: 'RLM',
  8234: 'LRE',
  8235: 'RLE',
  8236: 'PDF',
  8237: 'LRO',
  8238: 'RLO',
  8288: 'WJ',
  8294: 'LRI',
  8295: 'RLI',
  8296: 'FSI',
  8297: 'PDI',
  65279: 'BOM',
};

const hex = (code: number): string =>
  code.toString(16).toUpperCase().padStart(4, '0');

/**
 * The marker for a character a person cannot read in place, or null when it
 * shows as itself. Newline and tab stay: they are how a command is laid out.
 */
export const markerFor = (char: string): string | null => {
  const code = char.codePointAt(0) ?? 0;
  const name = NAMED[code];
  if (name) return `U+${hex(code)} ${name}`;
  const control =
    (code < 0x20 && code !== 0x0a && code !== 0x09) ||
    (code >= 0x7f && code <= 0x9f);
  return control ? `U+${hex(code)}` : null;
};

/**
 * The input split into text, markers for control, bidi and zero-width
 * characters, and redacted spans. Nothing is dropped: the segments joined, with
 * each marker standing for its one character, are the whole input.
 */
export const revealInput = (input: string): InputSegment[] => {
  const out: InputSegment[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ kind: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < input.length) {
    if (input.startsWith(REDACTION_MASK, i)) {
      flush();
      out.push({ kind: 'redacted' });
      i += REDACTION_MASK.length;
      continue;
    }
    const char = String.fromCodePoint(input.codePointAt(i) ?? 0);
    const label = markerFor(char);
    if (label) {
      flush();
      out.push({ kind: 'marker', label });
    } else text += char;
    i += char.length;
  }
  flush();
  return out;
};

/** First non-empty line of the input, visible characters only, cut for a title. */
export const inputFirstLine = (input: string, max = 80): string => {
  const line =
    input
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const shown = revealInput(line)
    .map((s) =>
      s.kind === 'text'
        ? s.text
        : s.kind === 'redacted'
          ? REDACTION_MASK
          : `‹${s.label}›`,
    )
    .join('');
  return shown.length > max ? `${shown.slice(0, max)}…` : shown;
};

export type ToolUseReview = {
  toolName: string;
  /** Title of the dialog: the tool plus the first line of its input. */
  title: string;
  segments: InputSegment[];
  /** No input, or only a preview of it: the person types the tool name to approve. */
  mustTypeName: boolean;
  reason: 'no_input' | 'truncated' | null;
};

/** What the approve dialog of a `tool_use` request shows; null for other kinds. */
export const reviewToolUse = (
  request: Pick<ActionRequestSummary, 'kind' | 'args'>,
): ToolUseReview | null => {
  const tool = toolUseArgs(request);
  if (!tool) return null;
  const input = tool.input ?? '';
  const reason = !input ? 'no_input' : tool.truncated ? 'truncated' : null;
  const first = inputFirstLine(input);
  return {
    toolName: tool.toolName,
    title: first
      ? `Approve ${tool.toolName}: ${first}?`
      : `Approve ${tool.toolName}?`,
    segments: revealInput(input),
    mustTypeName: reason !== null,
    reason,
  };
};

/** Whether the confirm button of a `tool_use` dialog may be pressed. */
export const toolUseConfirmable = (
  review: ToolUseReview,
  typed: string,
): boolean => !review.mustTypeName || typed.trim() === review.toolName;

/**
 * What pressing Approve or Deny on a request does first: a `tool_use` Deny
 * decides at once; everything else, and every Approve, asks in a dialog.
 */
export const stepFor = (
  request: Pick<ActionRequestSummary, 'kind'>,
  decision: 'approve' | 'deny',
): 'decide' | 'confirm' =>
  request.kind === 'tool_use' && decision === 'deny' ? 'decide' : 'confirm';
