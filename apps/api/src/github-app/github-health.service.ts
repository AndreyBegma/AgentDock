import type {
  GitHubHealthReason,
  GitHubProjectAppStatus,
} from '@agentdock/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RunnerWatchList } from '../runners/runner-watch-list';
import {
  GITHUB_APP_OPTIONS,
  type GitHubAppOptions,
} from './github-app-options';
import { GitHubAppStore } from './github-app-store';
import { computeProjectHealth, type HealthInstallation } from './github-health';

/** Deliveries ask for a recompute; requests within this window share one. */
const RECOMPUTE_COALESCE_MS = 1_000;

/**
 * D10–D12: each project's App health, stored in `github_project_health`,
 * recomputed every 5 minutes and after deliveries, resyncs and registration
 * changes. A project whose state flips gets its runner's watch list pushed,
 * so the runner's `issues` and `prs` collectors change cadence on their next
 * tick (D12).
 */
@Injectable()
export class GitHubHealthService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(GitHubHealthService.name);
  private interval: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: GitHubAppStore,
    private readonly watchList: RunnerWatchList,
    @Inject(GITHUB_APP_OPTIONS) private readonly options: GitHubAppOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoStart) return;
    this.interval = setInterval(
      () => void this.recompute().catch((error: unknown) => this.fail(error)),
      this.options.healthIntervalMs,
    );
    this.interval.unref();
    void this.recompute().catch((error: unknown) => this.fail(error));
  }

  onApplicationShutdown(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.soon) clearTimeout(this.soon);
  }

  /** A recompute shortly; calls within a second share one. */
  recomputeSoon(): void {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.recompute().catch((error: unknown) => this.fail(error));
    }, RECOMPUTE_COALESCE_MS);
    this.soon.unref();
  }

  /** Recomputes every project; concurrent calls run one after another. */
  recompute(now: Date = new Date()): Promise<void> {
    const next = this.running.then(
      () => this.recomputeNow(now),
      () => this.recomputeNow(now),
    );
    this.running = next.catch(() => undefined);
    return next;
  }

  /** `GET /projects/:projectId/github-app`. Computed on first read. */
  async statusFor(projectId: string): Promise<GitHubProjectAppStatus> {
    let row = await this.prisma.gitHubProjectHealth.findUnique({
      where: { projectId },
    });
    if (!row) {
      await this.recompute();
      row = await this.prisma.gitHubProjectHealth.findUnique({
        where: { projectId },
      });
    }
    if (!row)
      return {
        covered: false,
        state: 'unhealthy',
        reason: 'not_registered',
        checkedAt: null,
      };
    return {
      covered: row.covered,
      state: row.state === 'healthy' ? 'healthy' : 'unhealthy',
      reason: row.reason as GitHubHealthReason | null,
      checkedAt: row.checkedAt.toISOString(),
    };
  }

  private async recomputeNow(now: Date): Promise<void> {
    const [app, projects, repos, deliveries, stored] = await Promise.all([
      this.store.load(),
      this.prisma.project.findMany({
        select: { id: true, repo: true, runnerId: true },
      }),
      this.prisma.gitHubInstallationRepo.findMany({
        select: {
          fullName: true,
          installation: {
            select: { id: true, suspended: true, syncedAt: true },
          },
        },
      }),
      this.prisma.gitHubDelivery.groupBy({
        by: ['installationId'],
        where: { installationId: { not: null } },
        _max: { receivedAt: true },
      }),
      this.prisma.gitHubProjectHealth.findMany(),
    ]);

    const lastDelivery = new Map<number, Date | null>(
      deliveries.map((d) => [d.installationId ?? -1, d._max.receivedAt]),
    );
    const byRepo = new Map<string, HealthInstallation[]>();
    for (const { fullName, installation } of repos) {
      const list = byRepo.get(fullName) ?? [];
      list.push({
        suspended: installation.suspended,
        syncedAt: installation.syncedAt,
        lastDeliveryAt: lastDelivery.get(installation.id) ?? null,
      });
      byRepo.set(fullName, list);
    }
    const before = new Map(stored.map((row) => [row.projectId, row.state]));

    const flipped = new Set<string>();
    for (const project of projects) {
      const health = computeProjectHealth(
        app,
        byRepo.get(project.repo.toLowerCase()) ?? [],
        now,
      );
      const data = {
        covered: health.covered,
        state: health.state,
        reason: health.reason,
        checkedAt: now,
      };
      await this.prisma.gitHubProjectHealth.upsert({
        where: { projectId: project.id },
        create: { projectId: project.id, ...data },
        update: data,
      });
      // A project with no row was `unhealthy` on the wire (absent = unhealthy).
      if ((before.get(project.id) ?? 'unhealthy') !== health.state)
        flipped.add(project.runnerId);
    }
    for (const runnerId of flipped) {
      await this.watchList.push(runnerId).catch((error: unknown) => {
        this.logger.warn(
          `runner ${runnerId}: watch list not pushed: ${(error as Error).message}`,
        );
      });
    }
  }

  private fail(error: unknown): void {
    this.logger.error(`health recompute failed: ${(error as Error).message}`);
  }
}
