import type { GitHubAppHealth } from '@agentdock/shared/protocol';
import type { Clock } from '../clock';

/** Spec 27 D12: the cadence of `issues` and `prs` while the GitHub App is healthy. */
export const APP_HEALTHY_POLL_MS = 10 * 60_000;

/** Interval timers drift; a tick this close to the cadence still counts as due. */
const SLACK_MS = 1_000;

/**
 * Decides whether a regular interval tick should poll (spec 27 D12). The
 * interval keeps running at its own cadence (60 s); while the project's App is
 * `healthy` a tick polls only once {@link APP_HEALTHY_POLL_MS} has passed since
 * the last poll — of any kind, so a `collector.poll` pushes the next regular
 * one back. Absent or `unhealthy` polls on every tick, which makes the
 * fallback take effect on the very next tick, without a restart.
 */
export class AppPacing {
  private health: GitHubAppHealth | undefined;
  private lastPoll: number | null = null;

  constructor(private readonly clock: Clock) {}

  setHealth(health: GitHubAppHealth | undefined): void {
    this.health = health;
  }

  /** A poll is starting now, whatever triggered it. */
  polled(): void {
    this.lastPoll = this.clock.now();
  }

  /** Whether a regular tick should poll. */
  due(): boolean {
    if (this.health !== 'healthy' || this.lastPoll === null) return true;
    return this.clock.now() - this.lastPoll >= APP_HEALTHY_POLL_MS - SLACK_MS;
  }
}
