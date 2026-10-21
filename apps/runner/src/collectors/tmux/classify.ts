import type { PaneDialog, QuotaLimit } from '@nautelle/shared/protocol';
import { parseResetsAt } from '../../quota/reset';

/**
 * The Claude Code launch dialogs `watch.sh` recognises (spec 11 D2), in
 * `DIALOG_PATTERNS` order, each with the dialog it names. Kept in step with
 * `watch.sh`: a dialog added there is a line added here, with a fixture.
 */
export const DIALOG_PATTERNS: readonly (readonly [RegExp, PaneDialog])[] = [
  [/Do you trust the files in this folder/, 'trust'],
  // #624: the newer trust dialog, with or without pre-approved permissions.
  [/Accessing workspace:/, 'trust'],
  [/Quick safety check/, 'settings'],
  [/pre-approves/, 'settings'],
  [/Bypass Permissions mode, Claude Code will not ask/, 'bypass'],
  [/WARNING: Claude Code running in Bypass Permissions mode/, 'bypass'],
  [/now uses usage credits/, 'credits'],
  [/Manage usage credits on claude\.ai/, 'credits'],
];

/** `watch.sh`: a pane showing this is working. */
export const BUSY_MARKER = 'esc to interrupt';

/** The quota banners, in the order they are tried (spec 741 D1). */
const QUOTA_PATTERNS: readonly (readonly [RegExp, QuotaLimit])[] = [
  [/hit your weekly limit/i, 'weekly'],
  [/hit your (?:session|5-hour) limit/i, 'session'],
  [/usage limit reached/i, 'usage'],
  [/hit your usage limit/i, 'usage'],
  // A limit banner worded some new way: still a limit, never resumed.
  [/hit your [\w-]+ limit/i, 'unknown'],
];

export interface QuotaReading {
  limit: QuotaLimit;
  /** The banner's reset time, ISO-8601 UTC; null when it shows none that parses. */
  resetsAt: string | null;
}

export interface QuotaContext {
  now?: Date;
  /** The zone a banner without one is read in. */
  zone?: string;
}

/**
 * The one quota detector (spec 741 D1): the Board, the orchestrator and the
 * steward all read a pane's limit banner through it.
 */
export const detectQuota = (
  text: string,
  context: QuotaContext = {},
): QuotaReading | null => {
  for (const [pattern, limit] of QUOTA_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    // The reset time is on the banner's own line.
    const after =
      text.slice(match.index + match[0].length).split('\n')[0] ?? '';
    return {
      limit,
      resetsAt: parseResetsAt(after, {
        now: context.now ?? new Date(),
        zone: context.zone,
      }),
    };
  }
  return null;
};

export interface PaneReading {
  /** What `classify_pane` sees: a dialog, a busy pane, or neither. */
  kind: 'dialog' | 'busy' | 'quiet';
  dialog?: PaneDialog;
  /** The quota banner on screen, if any; `watch.sh` checks it apart from the rest. */
  quota: QuotaReading | null;
}

/** One captured pane, read as `watch.sh` reads it — a pure function of the text. */
export const classifyPane = (
  text: string,
  context?: QuotaContext,
): PaneReading => {
  const quota = detectQuota(text, context);
  const dialog = DIALOG_PATTERNS.find(([pattern]) => pattern.test(text));
  if (dialog) return { kind: 'dialog', dialog: dialog[1], quota };
  if (text.includes(BUSY_MARKER)) return { kind: 'busy', quota };
  return { kind: 'quiet', quota };
};
