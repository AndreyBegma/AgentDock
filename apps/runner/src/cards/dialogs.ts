import type { Exec } from '../detect/exec';

/**
 * #435: Claude Code modals that block a card's session and need no decision.
 * The one list of them: the dialog's title and options exactly as the pane
 * renders them, and the tmux key that answers with the option that changes
 * nothing. A permission prompt is never listed here — and a dialog that is
 * not listed is never answered.
 */
export interface KnownDialog {
  readonly name: string;
  /** The first line inside the dialog's frame. */
  readonly title: string;
  /** The numbered options, in order, without their numbers. */
  readonly options: readonly string[];
  /** A tmux key name, sent as one `send-keys` argument. */
  readonly key: string;
}

export const KNOWN_DIALOGS: readonly KnownDialog[] = [
  {
    // Shown after several auto-mode classifier denials in a profile;
    // 1. Yes  2. Not now  3. Don't show again. Escape is "Not now".
    name: 'teach-auto-mode',
    title: 'Teach auto mode about your environment?',
    options: ['Yes', 'Not now', "Don't show again"],
    key: 'Escape',
  },
];

/** At most this many lines are walked up from the frame's bottom border. */
const FRAME_MAX_LINES = 40;
/** At most this many key-hint lines may follow the frame. */
const FOOTER_MAX_LINES = 2;

const FRAME_TOP = /^\s*╭─+╮\s*$/;
const FRAME_BOTTOM = /^\s*╰─+╯\s*$/;
const FRAME_SIDE = /^\s*│(.*)│\s*$/;
/** "Enter to confirm · Esc to cancel" under a modal. */
const FOOTER = /^\s*(?:Enter|Esc|↑\/↓)\b[^│]*\bto\b/i;
const OPTION = /^(?:❯\s*)?\d+\.\s+(.+)$/;

/** Curly apostrophes as straight ones, the line trimmed. */
const plain = (text: string): string => text.replace(/[‘’]/g, "'").trim();

/**
 * The lines inside the frame that is the pane's bottom block — the frame
 * whose bottom border is the last line, key hints aside — or null when the
 * pane does not end in one. An input box with output above it, or output
 * below a frame, is never a dialog: what an agent prints scrolls above the
 * input box (#447 DR-08).
 */
export const bottomFrame = (pane: string): string[] | null => {
  const lines = pane.split('\n').map((line) => line.trimEnd());
  let end = lines.length - 1;
  while (end >= 0 && (lines[end] ?? '').trim() === '') end -= 1;
  for (let n = 0; n < FOOTER_MAX_LINES && end >= 0; n += 1) {
    const line = lines[end] ?? '';
    if (!FOOTER.test(line)) break;
    end -= 1;
    while (end >= 0 && (lines[end] ?? '').trim() === '') end -= 1;
  }
  if (end < 0 || !FRAME_BOTTOM.test(lines[end] ?? '')) return null;
  const inner: string[] = [];
  for (let i = end - 1; i >= 0 && end - i <= FRAME_MAX_LINES; i -= 1) {
    const line = lines[i] ?? '';
    if (FRAME_TOP.test(line)) return inner.reverse();
    const side = FRAME_SIDE.exec(line);
    if (!side) return null;
    inner.push(plain(side[1] ?? ''));
  }
  return null;
};

/**
 * The known dialog the pane shows as its current prompt, or null: its
 * frame is the pane's bottom block, its first line is the dialog's title,
 * and its numbered options are exactly the dialog's, in order. The same
 * text anywhere else — scrollback, an agent's output — is never a match.
 */
export const matchKnownDialog = (pane: string): KnownDialog | null => {
  const inner = bottomFrame(pane);
  if (!inner) return null;
  const content = inner.filter((line) => line.length > 0);
  const options = content.flatMap((line) => {
    const option = OPTION.exec(line);
    return option ? [plain(option[1] ?? '')] : [];
  });
  return (
    KNOWN_DIALOGS.find(
      (d) =>
        content[0] === d.title &&
        options.length === d.options.length &&
        d.options.every((label, i) => options[i] === label),
    ) ?? null
  );
};

/** Answers `dialog` in the card's tmux session; true when the key was sent. */
export const answerDialog = async (
  exec: Exec,
  tmuxServer: readonly string[],
  session: string,
  dialog: KnownDialog,
): Promise<boolean> => {
  const result = await exec('tmux', [
    ...tmuxServer,
    'send-keys',
    '-t',
    `=${session}:`,
    dialog.key,
  ]);
  return result?.code === 0;
};
