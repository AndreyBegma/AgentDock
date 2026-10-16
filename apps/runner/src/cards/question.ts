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
