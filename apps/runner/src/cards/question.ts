import { createHash } from 'node:crypto';
import {
  PENDING_QUESTION_LABEL_MAX_CHARS,
  PENDING_QUESTION_MAX_OPTIONS,
  PENDING_QUESTION_TEXT_MAX_CHARS,
  type PendingQuestion,
  pendingQuestionSchema,
} from '@agentdock/shared';

/**
 * #473: Claude Code's question selector — the `AskUserQuestion` tool waiting
 * for the person. It is not a permission prompt and not a dialog a runner
 * may answer: the round waits for the person, so the Board says so.
 *
 * The selector is the pane's bottom block: either the key hints
 * `Enter to select · … to navigate` (one question, or one tab of several),
 * or the review screen of several questions, which ends in
 * `1. Submit answers` / `2. Cancel` with no hints under it. The same text
 * anywhere above — scrollback, an agent's output — is never a match.
 */

/** At most this many lines are walked up from the bottom for the header. */
const BLOCK_MAX_LINES = 60;

const FOOTER = /^Enter to select · .*\bto navigate\b/;
const REVIEW_QUESTION = /^Ready to submit your answers\?$/;
const REVIEW_SUBMIT = /^(?:❯\s*)?1\.\s+Submit answers$/;
const REVIEW_CANCEL = /^(?:❯\s*)?2\.\s+Cancel$/;
/** The header line: `☐ glass-ui`, or the tabs `←  ☐ Colour  ☒ Size  ✔ Submit  →`. */
const HEADER = /[☐☒]/;
/** What changes on the header while the person answers. */
const HEADER_STATE = /[☐☒✔←→]/g;

export interface PaneQuestion {
  /**
   * The question's header with its answer state left out — the same for
   * every screen of one question, so a question is reported once however
   * the person moves through it.
   */
  readonly key: string;
}

/** The question selector the pane shows as its current prompt, or null. */
export const matchQuestion = (pane: string): PaneQuestion | null => {
  const lines = pane
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.length - 1;
  const shown =
    FOOTER.test(lines[last] ?? '') ||
    (REVIEW_CANCEL.test(lines[last] ?? '') &&
      REVIEW_SUBMIT.test(lines[last - 1] ?? '') &&
      REVIEW_QUESTION.test(lines[last - 2] ?? ''));
  if (!shown) return null;
  for (let i = last - 1; i >= 0 && last - i <= BLOCK_MAX_LINES; i -= 1) {
    const line = lines[i] ?? '';
    if (HEADER.test(line)) {
      return {
        key: line.replace(HEADER_STATE, ' ').replace(/\s+/g, ' ').trim(),
      };
    }
  }
  return { key: '' };
};

const OPTION_LINE = /^(❯\s*)?(\d{1,2})\.\s+(.+)$/;
const SEPARATOR = /^[─━-]{3,}$/;
/** The selector's typed-answer option, and the one that leaves it to chat. */
const OTHER_LABEL = /^Type something\.?$/;
const CHAT_LABEL = /^Chat about this$/;

/** One screen of the selector, as the runner answers it. */
export interface QuestionScreen {
  readonly question: PendingQuestion;
  /** The number of the option under the cursor; null when none is marked. */
  readonly cursor: number | null;
  /** The number of the "Type something." option; null without one. */
  readonly otherIndex: number | null;
  /** Every numbered option of the screen, in order (#489 M4). */
  readonly numbers: readonly number[];
}

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const screenKey = (header: string | null, text: string, labels: string[]) =>
  createHash('sha256')
    .update(JSON.stringify([header, text, labels]))
    .digest('hex')
    .slice(0, 16);

/**
 * #489 M4: the selector's current screen — header, question, options and
 * where the cursor is — or null when the pane shows none (`matchQuestion`).
 * "Type something." is the "Other" field; "Chat about this" is left out.
 */
export const readQuestion = (pane: string): QuestionScreen | null => {
  if (!matchQuestion(pane)) return null;
  const lines = pane
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let headerAt = -1;
  for (
    let i = lines.length - 1;
    i >= 0 && lines.length - 1 - i <= BLOCK_MAX_LINES;
    i -= 1
  ) {
    if (HEADER.test(lines[i] ?? '')) {
      headerAt = i;
      break;
    }
  }
  const block = lines.slice(headerAt + 1);
  const header =
    headerAt >= 0
      ? (lines[headerAt] ?? '')
          .replace(/[☐☒✔]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : null;
  const textLines: string[] = [];
  const options: { index: number; label: string; description: string[] }[] = [];
  let cursor: number | null = null;
  for (const line of block) {
    if (FOOTER.test(line) || SEPARATOR.test(line)) continue;
    const option = OPTION_LINE.exec(line);
    if (option) {
      const index = Number(option[2]);
      if (option[1]) cursor = index;
      options.push({ index, label: option[3] ?? '', description: [] });
      continue;
    }
    const last = options.at(-1);
    if (last) last.description.push(line);
    else textLines.push(line);
  }
  const other = options.find((o) => OTHER_LABEL.test(o.label)) ?? null;
  const shown = options.filter((o) => o !== other && !CHAT_LABEL.test(o.label));
  if (shown.length === 0) return null;
  const text = cut(textLines.join('\n'), PENDING_QUESTION_TEXT_MAX_CHARS);
  const listed = shown.slice(0, PENDING_QUESTION_MAX_OPTIONS).map((o) => {
    const description = o.description.join(' ');
    return {
      index: o.index,
      label: cut(o.label, PENDING_QUESTION_LABEL_MAX_CHARS),
      ...(description
        ? { description: cut(description, PENDING_QUESTION_LABEL_MAX_CHARS) }
        : {}),
    };
  });
  const question = pendingQuestionSchema.parse({
    key: screenKey(
      header,
      text,
      options.map((o) => o.label),
    ),
    header: header ? cut(header, PENDING_QUESTION_LABEL_MAX_CHARS) : null,
    text,
    options: listed,
    other: other !== null,
  });
  return {
    question,
    cursor,
    otherIndex: other?.index ?? null,
    numbers: options.map((o) => o.index),
  };
};

/** A tmux key name, or text to type with `send-keys -l`. */
export type AnswerStep =
  | { readonly key: 'Up' | 'Down' | 'Enter' }
  | { readonly literal: string };

/**
 * #489 M4: the keys that answer `screen` with option `index`, or with typed
 * `text` in its "Other" field — cursor moves to the option, then Enter (the
 * typed text goes between). Null when the screen has no such option.
 */
export const answerSteps = (
  screen: QuestionScreen,
  answer: { index: number } | { text: string },
): AnswerStep[] | null => {
  const target = 'index' in answer ? answer.index : screen.otherIndex;
  if (target === null) return null;
  if (
    'index' in answer &&
    !screen.question.options.some((o) => o.index === target)
  ) {
    return null;
  }
  const at = screen.numbers.indexOf(screen.cursor ?? screen.numbers[0] ?? 0);
  const to = screen.numbers.indexOf(target);
  if (at === -1 || to === -1) return null;
  const moves: AnswerStep[] = Array.from({ length: Math.abs(to - at) }, () =>
    to > at ? { key: 'Down' as const } : { key: 'Up' as const },
  );
  return 'text' in answer
    ? [...moves, { literal: answer.text }, { key: 'Enter' }]
    : [...moves, { key: 'Enter' }];
};
