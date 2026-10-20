import {
  type AdminRunner,
  RUNNER_ERROR,
  type RunnerStatus,
} from '@nautelle/shared';
import type { Capabilities } from '@nautelle/shared/protocol';
import { ApiError, describeError } from '../api';
import { RUN_COMMAND } from './install';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

/** Spec "UI": online ok, stale warn, offline neutral, revoked danger. */
export const STATUS_TONE: Record<RunnerStatus, Tone> = {
  online: 'ok',
  stale: 'warn',
  offline: 'neutral',
  revoked: 'danger',
};

export const RUNNER_STATUS_LABEL: Record<RunnerStatus, string> = {
  online: 'online',
  stale: 'not responding',
  offline: 'offline',
  revoked: 'revoked',
};

/**
 * A runner that never paired reads `offline` with `pairedAt: null`; one that
 * paired but never connected has `lastSeenAt: null` (pass it to tell them apart).
 */
export function statusLabel(
  status: RunnerStatus,
  pairedAt: string | null,
  lastSeenAt?: string | null,
): string {
  if (status === 'offline' && pairedAt === null) return 'not paired';
  if (status === 'offline' && lastSeenAt === null)
    return 'paired · not running';
  return RUNNER_STATUS_LABEL[status];
}

/** A next step: the sentence, and the command it names (rendered as code). */
export interface RunnerRemedy {
  text: string;
  command?: string;
}

/**
 * The next step for a runner that is not online, as one line under its
 * status; null when it is online.
 */
export function runnerRemedy(
  runner: Pick<AdminRunner, 'status' | 'pairedAt'>,
): RunnerRemedy | null {
  switch (runner.status) {
    case 'online':
      return null;
    case 'revoked':
      return {
        text: 'Revoked: it cannot reconnect. To use the machine again, add a new runner.',
      };
    case 'stale':
      return {
        text: 'Its heartbeat stopped. Check the machine, then restart',
        command: RUN_COMMAND,
      };
    case 'offline':
      return runner.pairedAt === null
        ? {
            text: 'Not paired yet. Open the runner for a new pairing code if the old one expired.',
          }
        : { text: 'Start it on its machine:', command: RUN_COMMAND };
  }
}

export function formatLastSeen(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** "0.42 / 0.51 / 0.60" with its meaning, for a heartbeat's 1/5/15 min load. */
export function formatLoad(load: readonly number[]): string {
  return load.map((value) => value.toFixed(2)).join(' / ');
}

export const LOAD_LABEL = 'load 1/5/15 min';

/** Profile labels for a table cell: "work, personal +2"; '' for none. */
export function profilesSummary(
  profiles: readonly { label: string; missing?: boolean }[],
  show = 2,
): string {
  const present = profiles.filter((profile) => !profile.missing);
  const names = present.slice(0, show).map((profile) => profile.label);
  const rest = present.length - names.length;
  return rest > 0 ? `${names.join(', ')} +${rest}` : names.join(', ');
}

/** `m:ss` until `expiresAt`; `null` once it has passed. */
export function formatCountdown(
  expiresAt: string,
  now = Date.now(),
): string | null {
  const left = Math.ceil((Date.parse(expiresAt) - now) / 1000);
  if (left <= 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** Capabilities as flat label / value rows for the detail sheet. */
export function capabilityRows(
  capabilities: Capabilities,
): { label: string; value: string }[] {
  const { gh, runtimes, codeSentinel, otlp } = capabilities;
  const found = (value: string | null | undefined) => value ?? 'not found';
  return [
    { label: 'tmux', value: found(capabilities.tmux) },
    { label: 'git', value: found(capabilities.git) },
    {
      label: 'gh',
      value: gh
        ? `${gh.version} · ${gh.authenticated ? `signed in${gh.user ? ` as ${gh.user}` : ''}` : 'not signed in'}`
        : 'not found',
    },
    { label: 'claude', value: found(runtimes.claude?.version) },
    { label: 'codex', value: found(runtimes.codex?.version) },
    { label: 'code-sentinel', value: found(codeSentinel?.version) },
    {
      label: 'OTLP',
      value: otlp
        ? [
            otlp.grpc ? `grpc :${otlp.grpc}` : null,
            otlp.http ? `http :${otlp.http}` : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'off'
        : 'off',
    },
  ];
}

/** What the machine can run, for a table cell: "claude · codex · gh"; '' for nothing. */
export function capabilitySummary(capabilities: Capabilities): string {
  const { gh, runtimes } = capabilities;
  return [
    runtimes.claude?.version ? 'claude' : null,
    runtimes.codex?.version ? 'codex' : null,
    gh?.authenticated ? 'gh' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A sentence for the user; falls back to the shared auth wording. */
export function describeRunnerError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code as string | undefined) {
      case RUNNER_ERROR.notFound:
        return 'This runner no longer exists. Refresh the list.';
      case RUNNER_ERROR.invalidTransition:
        return 'This runner is revoked, so that is no longer possible.';
      case RUNNER_ERROR.forbidden:
        return 'You do not have access to this.';
    }
  }
  return describeError(error);
}
