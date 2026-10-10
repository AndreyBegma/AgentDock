import { GITHUB_APP_ERROR, type GitHubResyncResult } from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { githubAppError } from './github-app-error';
import { GitHubAppStore } from './github-app-store';
import {
  GitHubAppClient,
  GitHubRequestError,
  type InstallationRepo,
} from './github-client';
import { GitHubHealthService } from './github-health.service';

/**
 * D10: the App's installations and their repositories, as GitHub lists them,
 * replace what `github_installations` / `github_installation_repos` held.
 * Run on registration, on `installation*` deliveries and on a manual resync.
 * The hook-deliveries check of D11 (b) runs with it.
 */
@Injectable()
export class GitHubInstallationsService {
  private readonly logger = new Logger(GitHubInstallationsService.name);
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: GitHubAppStore,
    private readonly client: GitHubAppClient,
    private readonly health: GitHubHealthService,
  ) {}

  /** Concurrent calls run one after another, so the newest listing wins. */
  resync(now: Date = new Date()): Promise<GitHubResyncResult> {
    const next = this.running.then(
      () => this.resyncNow(now),
      () => this.resyncNow(now),
    );
    this.running = next.catch(() => undefined);
    return next;
  }

  /** A resync in the background (deliveries, registration); failures are logged. */
  resyncInBackground(): void {
    void this.resync().catch((error: unknown) => {
      this.logger.warn(
        `installation resync failed: ${(error as Error).message}`,
      );
    });
  }

  private async resyncNow(now: Date): Promise<GitHubResyncResult> {
    const app = await this.store.require();
    const key = this.store.privateKey(app);
    if (!key)
      throw githubAppError(
        409,
        GITHUB_APP_ERROR.invalidCredentials,
        'The stored private key cannot be used; re-enter the App credentials',
      );

    const installations = await this.github(() =>
      this.client.listInstallations(app.appId, key),
    );
    const repos = new Map<number, InstallationRepo[]>();
    for (const installation of installations) {
      // A suspended installation cannot mint a token; its repos stay as they were.
      if (installation.suspended) continue;
      repos.set(
        installation.id,
        await this.github(() =>
          this.client.listInstallationRepos(app.appId, key, installation.id),
        ),
      );
    }
    let hookCheckOk: boolean | null = null;
    try {
      hookCheckOk = await this.client.latestHookDeliveryOk(app.appId, key);
    } catch (error) {
      // D11 (b) is one input of health; a failed check is not a failed resync.
      this.logger.warn(
        `hook deliveries check failed: ${(error as Error).message}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.gitHubInstallation.deleteMany({
        where: { id: { notIn: installations.map((i) => i.id) } },
      });
      for (const installation of installations) {
        const data = {
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          suspended: installation.suspended,
          syncedAt: now,
        };
        await tx.gitHubInstallation.upsert({
          where: { id: installation.id },
          create: { id: installation.id, ...data },
          update: data,
        });
        const listed = repos.get(installation.id);
        if (!listed) continue;
        await tx.gitHubInstallationRepo.deleteMany({
          where: { installationId: installation.id },
        });
        await tx.gitHubInstallationRepo.createMany({
          data: listed.map((repo) => ({
            installationId: installation.id,
            repoId: repo.repoId,
            fullName: repo.fullName,
          })),
          skipDuplicates: true,
        });
      }
      await tx.gitHubApp.update({
        where: { id: app.id },
        data: { hookCheckedAt: now, hookCheckOk },
      });
    });
    await this.health.recompute(now);

    let repoCount = 0;
    for (const list of repos.values()) repoCount += list.length;
    return {
      installations: installations.length,
      repos: repoCount,
      hookCheckOk,
    };
  }

  private async github<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof GitHubRequestError)) throw error;
      if (error.status === 401)
        throw githubAppError(
          409,
          GITHUB_APP_ERROR.invalidCredentials,
          'GitHub refused the App credentials',
        );
      throw githubAppError(
        502,
        GITHUB_APP_ERROR.githubUnavailable,
        error.message,
      );
    }
  }
}
