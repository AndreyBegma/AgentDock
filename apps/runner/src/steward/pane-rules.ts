import {
  STEWARD_DIALOG_IDS,
  STEWARD_PANE_TAIL_MAX_BYTES,
  type StewardDialogId,
  type StewardIncidentKind,
} from '@nautelle/shared';
import { matchKnownDialog } from '../cards/dialogs';
import { matchQuestion } from '../cards/question';
import { DIALOG_PATTERNS, QUOTA_MARKER } from '../collectors/tmux/classify';
import { redactText } from '../local/redact';

/**
 * #447 D6, D9, D11: what Steward reads in a captured Claude Code pane. Pure
 * functions of the text. Every `reason` is a fixed line of the rule that
 * matched — never pane text (D12) — so it can reach the API whatever the
 * project's content setting.
 */

/** A pane signal: an incident kind the pane shows by itself (D6). */
export type PaneSignal =
  | { kind: 'api_error'; reason: string }
  | { kind: 'dialog'; reason: string; dialogId?: StewardDialogId }
  | { kind: 'permission_prompt'; reason: string }
  | { kind: 'quota'; reason: string };

export interface StewardPaneReading {
  /**
   * `busy`: Claude Code is working (`esc to interrupt`). `idle`: the input
   * box is empty and nothing works — a nudge may be typed. `question`
   * (#473): the worker asks the person a question and waits for the answer.
   * `other`: none of these, such as a dialog or a half-typed input.
   */
  state: 'busy' | 'idle' | 'question' | 'other';
  signal: PaneSignal | null;
}

/** Claude Code's working line; a pane retrying an API call shows it too. */
const BUSY = /esc to interrupt/i;

/**
 * An empty input line: `│ >   │` in the boxed input, `❯` in the newer one.
 * A selected option of a dialog (`❯ 1. Yes`) has text after the marker, so
 * it is never an empty prompt.
 */
const EMPTY_PROMPT = /^\s*(?:│\s*)?[>❯]\s*(?:│\s*)?$/;

/** How far above the input box an API error still counts as the last output. */
const API_ERROR_WINDOW = 12;

/** The interrupted-response lines, each with the fixed reason it reports. */
export const API_ERROR_RULES: readonly (readonly [RegExp, string])[] = [
  [
    /Connection lost mid-response/i,
    'API error: the connection was lost mid-response',
  ],
  [
    /API Error:?\s*(?:\(?\s*)?(?:Overloaded|529)/i,
    'API error: the API was overloaded',
  ],
  [
    /API Error:?\s*\(?\s*Request timed out/i,
    'API error: the request timed out',
  ],
  [/API Error:?\s*\(?\s*Connection error/i, 'API error: a connection error'],
  [/\bAPI Error\b/i, 'API error: the response was cut off'],
];

/** A modal whatever it says: a selected numbered option, or its footer. */
const ANY_DIALOG: readonly RegExp[] = [
  /^\s*(?:│\s*)?❯\s*\d+\.\s/m,
  /Enter to confirm\s*·\s*Esc to (?:exit|cancel)/i,
];

/** The option only a permission prompt offers. */
const PERMISSION_OPTION = /No, and tell Claude what to do differently/i;
/** A permission prompt's question — only inside a modal, not in prose. */
const PERMISSION_QUESTION =
  /Do you want to (?:proceed|make this edit|create|allow|run|fetch|use|overwrite|delete)\b/i;

/**
 * Permission prompts: never answered, they escalate at once (D11). Matched
 * before any other dialog, so a prompt is never taken for a dialog; a
 * worker asking "Do you want to proceed?" in its own text is not one.
 */
const isPermissionPrompt = (text: string): boolean =>
  PERMISSION_OPTION.test(text) ||
  (PERMISSION_QUESTION.test(text) && ANY_DIALOG.some((p) => p.test(text)));

const QUOTA: readonly RegExp[] = [
  new RegExp(QUOTA_MARKER, 'i'),
  /usage limit reached/i,
  /hit your (?:session|usage|5-hour) limit/i,
];

const isDialogId = (name: string): name is StewardDialogId =>
  (STEWARD_DIALOG_IDS as readonly string[]).includes(name);

const lastNonEmpty = (lines: readonly string[], end: number, n: number) => {
  const found: string[] = [];
  for (let i = end - 1; i >= 0 && found.length < n; i -= 1) {
    const line = lines[i] ?? '';
    if (line.trim().length > 0) found.push(line);
  }
  return found;
};

/** The index of the last empty input line, or -1. */
const promptLine = (lines: readonly string[]): number => {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (EMPTY_PROMPT.test(lines[i] ?? '')) return i;
  }
  return -1;
};

/**
 * Reads one captured pane (D6), in a fixed order: a permission prompt, the
 * question selector (#473, no signal), a listed dialog, an unlisted one, the quota banner, then — only at an
 * empty, idle input box — an API error right above it.
 */
export const readPane = (text: string): StewardPaneReading => {
  const lines = text.split('\n');
  const busy = BUSY.test(text);
  // First: a pane with a permission prompt is never read as anything a
  // Steward command could answer (D11).
  if (isPermissionPrompt(text)) {
    return {
      state: 'other',
      signal: {
        kind: 'permission_prompt',
        reason: 'a permission prompt waits for a person',
      },
    };
  }
  // #473: a question the worker asks is the Board's — the round waits for
  // the person and `card.waiting` tells them — never a dialog to escalate.
  if (matchQuestion(text)) return { state: 'question', signal: null };
  const known = matchKnownDialog(text);
  if (known && isDialogId(known.name)) {
    return {
      state: 'other',
      signal: {
        kind: 'dialog',
        reason: `a known dialog blocks the session (${known.name})`,
        dialogId: known.name,
      },
    };
  }
  const launch = DIALOG_PATTERNS.find(([pattern]) => pattern.test(text));
  if (launch) {
    return {
      state: 'other',
      signal: {
        kind: 'dialog',
        reason: `an unknown dialog blocks the session (${launch[1]})`,
      },
    };
  }
  if (!busy && ANY_DIALOG.some((p) => p.test(text))) {
    return {
      state: 'other',
      signal: {
        kind: 'dialog',
        reason: 'an unknown dialog blocks the session',
      },
    };
  }
  if (QUOTA.some((p) => p.test(text))) {
    return {
      state: busy ? 'busy' : 'other',
      signal: { kind: 'quota', reason: 'the usage limit is reached' },
    };
  }
  if (busy) return { state: 'busy', signal: null };
  const prompt = promptLine(lines);
  if (prompt === -1) return { state: 'other', signal: null };
  // The box's top border and the output right above it.
  const above = lastNonEmpty(lines, prompt, API_ERROR_WINDOW);
  for (const [pattern, reason] of API_ERROR_RULES) {
    if (above.some((line) => pattern.test(line))) {
      return { state: 'idle', signal: { kind: 'api_error', reason } };
    }
  }
  return { state: 'idle', signal: null };
};

/** Whether a reading is a signal of `kind`. */
export const signalIs = (
  reading: StewardPaneReading,
  kind: StewardIncidentKind,
): boolean => reading.signal?.kind === kind;

const utf8 = new TextEncoder();

/**
 * D12: the pane's last lines, redacted, within `STEWARD_PANE_TAIL_MAX_BYTES`
 * — sent only when the project ships content. `null` for a blank pane.
 */
export const paneTail = (text: string): string | null => {
  const lines = redactText(text.replaceAll('\u0000', ''))
    .split('\n')
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    const size = utf8.encode(line).length + 1;
    if (bytes + size > STEWARD_PANE_TAIL_MAX_BYTES) break;
    kept.unshift(line);
    bytes += size;
  }
  const tail = kept.join('\n');
  return tail.trim().length > 0 ? tail : null;
};
