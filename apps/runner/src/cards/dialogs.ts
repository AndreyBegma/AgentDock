import type { Exec } from '../detect/exec';

/**
 * #435: Claude Code modals that block a card's session and need no decision.
 * The one list of them: the exact text the pane shows, and the tmux key that
 * answers with the option that changes nothing. A permission prompt is never
 * listed here — and a dialog that is not listed is never answered.
 */
export interface KnownDialog {
  readonly name: string;
  /** Every fragment must be in the visible pane. */
  readonly match: readonly string[];
  /** A tmux key name, sent as one `send-keys` argument. */
  readonly key: string;
}

export const KNOWN_DIALOGS: readonly KnownDialog[] = [
  {
    // Shown after several auto-mode classifier denials in a profile;
    // 1. Yes  2. Not now  3. Don't show again. Escape is "Not now".
    name: 'teach-auto-mode',
    match: ['Teach auto mode about your environment?', 'Not now'],
    key: 'Escape',
  },
];

/** The known dialog the pane shows, or null. */
export const matchKnownDialog = (pane: string): KnownDialog | null =>
  KNOWN_DIALOGS.find((d) => d.match.every((text) => pane.includes(text))) ??
  null;

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
