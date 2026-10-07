import { RUNNER_ERROR, type RunnerStatus } from '@agentdock/shared';
import type { Capabilities } from '@agentdock/shared/protocol';
import { ApiError, describeError } from '../api';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

/** Spec "UI": online ok, stale warn, offline neutral, revoked danger. */
export const STATUS_TONE: Record<RunnerStatus, Tone> = {
  online: 'ok',
  stale: 'warn',
  offline: 'neutral',
  revoked: 'danger',
};

/** A runner that never paired reads `offline` with `pairedAt: null`. */
export function statusLabel(
  status: RunnerStatus,
  pairedAt: string | null,
): string {
  return status === 'offline' && pairedAt === null ? 'not paired' : status;
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
