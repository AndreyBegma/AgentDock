import {
  GITHUB_HEALTH_WINDOW_MS,
  type GitHubHealthReason,
} from '@agentdock/shared';
import type { GitHubAppHealth } from '@agentdock/shared/protocol';

/** What D11 reads about the App. */
export interface HealthApp {
  hookActive: boolean;
  lastDeliveryAt: Date | null;
  lastSignatureFailureAt: Date | null;
  hookCheckedAt: Date | null;
  hookCheckOk: boolean | null;
}

/** What D11 reads about one installation that lists the project's repo. */
export interface HealthInstallation {
  suspended: boolean;
  syncedAt: Date;
  /** The newest verified delivery for any repo of this installation. */
  lastDeliveryAt: Date | null;
}

export interface ProjectHealth {
  covered: boolean;
  state: GitHubAppHealth;
  reason: GitHubHealthReason | null;
}

const within = (at: Date | null, now: Date): boolean =>
  at !== null && now.getTime() - at.getTime() <= GITHUB_HEALTH_WINDOW_MS;

/**
 * D10/D11 for one project. `installations`: every installation listing the
 * project's repo. Healthy needs (a) covered by an active installation,
 * (b) a verified delivery for that installation, or a resync with a good
 * hook-deliveries check, within the last 60 minutes, and (c) no signature
 * failure since the last verified delivery. The first failing rule is the
 * reason.
 */
export const computeProjectHealth = (
  app: HealthApp | null,
  installations: readonly HealthInstallation[],
  now: Date,
): ProjectHealth => {
  const active = installations.filter((i) => !i.suspended);
  const covered = app !== null && active.length > 0;
  const unhealthy = (reason: GitHubHealthReason): ProjectHealth => ({
    covered,
    state: 'unhealthy',
    reason,
  });
  if (!app) return unhealthy('not_registered');
  if (!app.hookActive) return unhealthy('hook_inactive');
  if (installations.length === 0) return unhealthy('not_covered');
  if (active.length === 0) return unhealthy('installation_suspended');
  if (
    app.lastSignatureFailureAt !== null &&
    (app.lastDeliveryAt === null ||
      app.lastSignatureFailureAt > app.lastDeliveryAt)
  )
    return unhealthy('signature_failure');
  const checkedOk = app.hookCheckOk === true && within(app.hookCheckedAt, now);
  const recent = active.some(
    (i) =>
      within(i.lastDeliveryAt, now) || (checkedOk && within(i.syncedAt, now)),
  );
  if (!recent) return unhealthy('no_recent_delivery');
  return { covered, state: 'healthy', reason: null };
};
