import {
  type CardDemoBrief,
  DEMO_ERROR,
  type DemoRunnerView,
  type DemoStatus,
} from '@nautelle/shared';
import { ApiError, describeError } from '../api';

/** The label a demo's status wears, in the Demo section and on a tile. */
export const DEMO_STATUS_LABEL: Readonly<Record<DemoStatus, string>> = {
  queued: 'Recording…',
  recording: 'Recording…',
  ready: 'Ready',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** The glass-ui `StatusPill` status a demo's status reads as. */
export const DEMO_PILL_STATUS: Readonly<
  Record<DemoStatus, 'running' | 'done' | 'error' | 'idle'>
> = {
  queued: 'running',
  recording: 'running',
  ready: 'done',
  failed: 'error',
  skipped: 'idle',
};

/**
 * The small chip a board tile wears for the card's newest demo: a play icon
 * and the length when it is ready, else the state in a word.
 */
export function demoChip(brief: CardDemoBrief): {
  label: string;
  tone: 'neutral' | 'ok' | 'warn' | 'danger';
  title: string;
} {
  switch (brief.status) {
    case 'ready':
      return {
        label: formatDuration(brief.durationMs) ?? 'Demo',
        tone: 'ok',
        title: 'Demo ready — open the card to watch it',
      };
    case 'failed':
      return {
        label: 'Demo failed',
        tone: 'danger',
        title: 'The demo failed; it does not block merging',
      };
    case 'skipped':
      return {
        label: 'Demo skipped',
        tone: 'neutral',
        title: 'No demo was recorded for this card',
      };
    default:
      return {
        label: 'Recording',
        tone: 'warn',
        title: 'Recording the demo',
      };
  }
}

/** `0:42`, `1:05`, `12:00` — a video's length. `null` while it is unknown. */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The scenario file in the card's pull request: the branch's blob page. `null`
 * without a scenario path or a PR link to build it from.
 */
export function scenarioUrl(
  prUrl: string | null | undefined,
  branch: string | null | undefined,
  scenarioPath: string | null,
): string | null {
  if (!scenarioPath || !prUrl || !branch) return null;
  const repo = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(prUrl);
  if (!repo) return null;
  const encoded = branch.split('/').map(encodeURIComponent).join('/');
  return `${repo[1]}/blob/${encoded}/${scenarioPath}`;
}

/** What to do about a runner that cannot record, or `null` when it can. */
export function runnerAdvice(runner: DemoRunnerView): string | null {
  if (!runner.supported) {
    return 'The runner is too old to record demos. Update the runner, then record again.';
  }
  if (!runner.demoflow) {
    return 'The runner has not reported DemoFlow yet. It reports it when it connects; restart the runner if this stays.';
  }
  if (!runner.demoflow.ready) {
    return `DemoFlow is not ready on the runner${
      runner.demoflow.reason ? `: ${runner.demoflow.reason}` : ''
    }. Fix that on the runner's machine; it reports again by itself.`;
  }
  return null;
}

export function describeDemoError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.body?.error) {
      case DEMO_ERROR.encryptionUnavailable:
        return 'The server has no encryption key (APP_ENCRYPTION_KEY), so a secret cannot be stored.';
      case DEMO_ERROR.tooManySecrets:
        return 'A project holds at most 32 demo secrets. Delete one first.';
      case DEMO_ERROR.disabled:
        return 'Demo videos are off for this project. Turn them on in Settings → Demo videos.';
      case DEMO_ERROR.inFlight:
        return 'This card is already being recorded.';
      case DEMO_ERROR.noRound:
        return 'This card has not run yet, so there is nothing to record.';
    }
    if (error.status === 403) {
      return 'Only project administrators can change Demo videos.';
    }
  }
  return describeError(error);
}
