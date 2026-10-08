import type { PaneDialog } from '@agentdock/shared/protocol';

/**
 * The Claude Code launch dialogs `watch.sh` recognises (spec 11 D2), in
 * `DIALOG_PATTERNS` order, each with the dialog it names. Kept in step with
 * `watch.sh`: a dialog added there is a line added here, with a fixture.
 */
export const DIALOG_PATTERNS: readonly (readonly [RegExp, PaneDialog])[] = [
  [/Do you trust the files in this folder/, 'trust'],
  [/Quick safety check/, 'settings'],
  [/pre-approves/, 'settings'],
  [/Bypass Permissions mode, Claude Code will not ask/, 'bypass'],
  [/WARNING: Claude Code running in Bypass Permissions mode/, 'bypass'],
  [/now uses usage credits/, 'credits'],
  [/Manage usage credits on claude\.ai/, 'credits'],
];

/** `watch.sh`: a pane showing this is working. */
export const BUSY_MARKER = 'esc to interrupt';
/** `watch.sh`: the weekly-limit banner. */
export const QUOTA_MARKER = 'hit your weekly limit';

export interface PaneReading {
  /** What `classify_pane` sees: a dialog, a busy pane, or neither. */
  kind: 'dialog' | 'busy' | 'quiet';
  dialog?: PaneDialog;
  /** The quota banner is on screen; `watch.sh` checks it apart from the rest. */
  quota: boolean;
}

/** One captured pane, read as `watch.sh` reads it — a pure function of the text. */
export const classifyPane = (text: string): PaneReading => {
  const quota = text.includes(QUOTA_MARKER);
  const dialog = DIALOG_PATTERNS.find(([pattern]) => pattern.test(text));
  if (dialog) return { kind: 'dialog', dialog: dialog[1], quota };
  if (text.includes(BUSY_MARKER)) return { kind: 'busy', quota };
  return { kind: 'quiet', quota };
};
