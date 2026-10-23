import type {
  CardRestartMode,
  CardRoundCiState,
  CardRoundView,
} from '@nautelle/shared';
import { formatCost, formatDuration, formatTokens } from '../format';
import { savedLabel } from '../token-saver/format';
import { githubUrl } from '../url';

/** One compact fact of a round: a label, its text and, when it links, where to. */
export interface RoundFact {
  key: string;
  label: string;
  value: string;
  href?: string | null;
  /** The text is a number or a commit — set in the mono, tabular face. */
  mono?: boolean;
}

/** A summary longer than this many characters or lines gets the "Show all" toggle. */
export const SUMMARY_CLAMP_LINES = 4;
const SUMMARY_CLAMP_CHARS = 280;

const RESTART_LABEL: Record<CardRestartMode, string> = {
  first: 'first start',
  resume: 'resumed',
  fresh: 'fresh start',
};

const CI_LABEL: Record<CardRoundCiState, string> = {
  pending: 'running',
  passed: 'passed',
  failed: 'failed',
};

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

/** When the round stopped, or `null` while it still runs. */
function stoppedAt(round: CardRoundView): number | null {
  return ms(round.finishedAt) ?? ms(round.endedAt);
}

/** The round's duration; for a round still running, up to `now`. */
export function roundDurationMs(
  round: CardRoundView,
  now: number,
): number | null {
  const start = ms(round.startedAt);
  if (start === null) return null;
  return Math.max(0, (stoppedAt(round) ?? now) - start);
}

/**
 * Time the round spent not working — waiting for a person, or on a background
 * command — from the first of the two stops to the end of the round; `null`
 * when it never stopped.
 */
export function roundWaitingMs(
  round: CardRoundView,
  now: number,
): number | null {
  const stops = [ms(round.waitingAt), ms(round.backgroundAt)].filter(
    (t): t is number => t !== null,
  );
  if (stops.length === 0) return null;
  return Math.max(0, (stoppedAt(round) ?? now) - Math.min(...stops));
}

/** The pull request line: `#12 · 2 commits · abc1234 · CI passed 5/5`. */
function pullRequestText(round: CardRoundView): string | null {
  const parts: string[] = [];
  if (round.pullRequest) parts.push(`#${round.pullRequest.number}`);
  if (round.commits != null && round.commits > 0) {
    parts.push(`${round.commits} commit${round.commits === 1 ? '' : 's'}`);
  }
  if (round.headSha) parts.push(round.headSha.slice(0, 7));
  return parts.length > 0 ? parts.join(' · ') : null;
}

function ciText(round: CardRoundView): string | null {
  const ci = round.ci;
  if (!ci) return null;
  const counts = ci.total > 0 ? ` ${ci.passed}/${ci.total}` : '';
  return `${CI_LABEL[ci.state]}${counts}`;
}

function restartText(round: CardRoundView): string | null {
  if (!round.restartMode) return null;
  const estimate = round.restartEstimate;
  const tokens =
    estimate && round.restartMode !== 'first'
      ? ` (≈ ${formatTokens(
          round.restartMode === 'resume'
            ? estimate.resumeTokens
            : estimate.freshTokens,
        )} tok in)`
      : '';
  return `${RESTART_LABEL[round.restartMode]}${tokens}`;
}

function warmupText(round: CardRoundView): string | null {
  const parts = [
    round.warmupTokens != null ? `${formatTokens(round.warmupTokens)} tok` : '',
    round.warmupMs != null ? formatDuration(round.warmupMs) : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** What the token-saver filters saved in the round, on one line. */
export function roundSavedText(round: CardRoundView): string | null {
  return savedLabel(round.tokenSaved);
}

/**
 * The round's facts, in reading order. A fact whose data is null is left out —
 * never shown empty (C-332).
 */
export function roundFacts(round: CardRoundView, now: number): RoundFact[] {
  const duration = roundDurationMs(round, now);
  const waiting = roundWaitingMs(round, now);
  const pr = pullRequestText(round);
  const ci = ciText(round);
  const model = [round.model, round.effort].filter(Boolean).join(' · ');
  const cost = formatCost(round.costUsd);
  const saved = roundSavedText(round);
  const restart = restartText(round);
  const warmup = warmupText(round);
  const facts: (RoundFact | false | null | '')[] = [
    model !== '' && { key: 'model', label: 'Model', value: model },
    duration !== null && {
      key: 'duration',
      label: stoppedAt(round) === null ? 'Running' : 'Duration',
      value: formatDuration(duration),
      mono: true,
    },
    waiting !== null &&
      waiting > 0 && {
        key: 'waiting',
        label: 'Waiting',
        value: formatDuration(waiting),
        mono: true,
      },
    // With a breakdown, the line is the breakdown's own one-line trigger.
    saved !== null &&
      !round.tokenSaverFilters?.length && {
        key: 'saved',
        label: 'Token saver',
        value: saved,
      },
    cost !== '' && { key: 'cost', label: 'Cost', value: cost, mono: true },
    pr !== null && {
      key: 'pr',
      label: 'Pull request',
      value: pr,
      href: round.pullRequest ? githubUrl(round.pullRequest.url) : null,
    },
    ci !== null && {
      key: 'ci',
      label: 'CI',
      value: ci,
      href: round.ci ? githubUrl(round.ci.url) : null,
    },
    round.exitCode != null && {
      key: 'exit',
      label: 'Exit code',
      value: String(round.exitCode),
      mono: true,
    },
    restart !== null && { key: 'restart', label: 'Start', value: restart },
    warmup !== null && { key: 'warmup', label: 'Warm-up', value: warmup },
  ];
  return facts.filter((f): f is RoundFact => !!f);
}

/** Whether a summary is long enough to clamp and offer "Show all". */
export function summaryNeedsClamp(summary: string): boolean {
  return (
    summary.length > SUMMARY_CLAMP_CHARS ||
    summary.split('\n').length > SUMMARY_CLAMP_LINES
  );
}
