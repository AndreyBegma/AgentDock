import { randomBytes } from 'node:crypto';
import {
  buildGitHubAppManifest,
  GITHUB_APP_ADMIN_PAGE,
  GITHUB_APP_ERROR,
  type GitHubAppCredentialsRequest,
  type GitHubAppErrorCode,
  type GitHubAppView,
  type GitHubManifestResponse,
  githubAppHtmlUrl,
  githubAppInstallUrl,
  githubManifestPostUrl,
} from '@agentdock/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { GitHubApp } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { GitHubAppFailure, githubAppError } from './github-app-error';
import {
  GITHUB_APP_OPTIONS,
  type GitHubAppOptions,
} from './github-app-options';
import { GITHUB_APP_ROW_ID, GitHubAppStore } from './github-app-store';
import { GitHubAppClient, GitHubRequestError } from './github-client';
import { GitHubHealthService } from './github-health.service';
import { GitHubInstallationsService } from './github-installations.service';
import { parseAppPrivateKey } from './github-jwt';

/** D1: how long a manifest flow's `state` stays valid. */
export const MANIFEST_STATE_TTL_MS = 60 * 60 * 1000;

/** What the audit log keeps of a registration: never a secret (D3, D16). */
const auditView = (app: GitHubApp) => ({
  appId: app.appId,
  slug: app.slug,
  ownerLogin: app.ownerLogin,
  hookActive: app.hookActive,
});

/**
 * Registering the instance's one App (D1, D3, D15, D16): the manifest flow,
 * the manual-credentials fallback, deletion, and the admin view. Every change
 * is audited; secrets are sealed before they touch the database and appear
 * in no response, log line or audit value.
 */
@Injectable()
export class GitHubRegistrationService {
  private readonly logger = new Logger(GitHubRegistrationService.name);
  /** D1: `state` → the admin who started the flow. In memory: one API process. */
  private readonly states = new Map<
    string,
    { userId: string; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: GitHubAppStore,
    private readonly client: GitHubAppClient,
    private readonly installations: GitHubInstallationsService,
    private readonly health: GitHubHealthService,
    private readonly audit: AuditService,
    @Inject(GITHUB_APP_OPTIONS) private readonly options: GitHubAppOptions,
  ) {}

  /** `POST /admin/github-app/manifest`. */
  async manifest(
    owner: string | undefined,
    userId: string,
  ): Promise<GitHubManifestResponse> {
    this.store.requireCipher();
    await this.requireUnregistered();
    this.pruneStates();
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, {
      userId,
      expiresAt: Date.now() + MANIFEST_STATE_TTL_MS,
    });
    return {
      postUrl: githubManifestPostUrl(state, owner),
      manifest: buildGitHubAppManifest({
        publicUrl: this.options.publicUrl,
        appUrl: this.options.appUrl,
      }),
      state,
    };
  }

  /**
   * `GET /admin/github-app/callback` (D1): the code exchange. Answers where
   * to send the browser — the admin page, with `registered=1` or `error=<code>`.
   */
  async callback(
    code: string,
    state: string,
    userId: string,
    ctx: AuditContext,
  ): Promise<string> {
    try {
      this.consumeState(state, userId);
      this.store.requireCipher();
      await this.requireUnregistered();
      const converted = await this.github(() =>
        this.client.convertManifest(code),
      );
      if (!parseAppPrivateKey(converted.privateKey))
        throw githubAppError(
          502,
          GITHUB_APP_ERROR.githubUnavailable,
          'GitHub returned a private key that is not an RSA PEM',
        );
      const sealed = this.store.seal(converted);
      const app = await this.prisma.gitHubApp.create({
        data: {
          id: GITHUB_APP_ROW_ID,
          appId: converted.appId,
          slug: converted.slug,
          ownerLogin: converted.ownerLogin,
          ...sealed,
          hookActive: this.options.publicUrl !== null,
          registeredById: userId,
        },
      });
      await this.audit.record({
        ...ctx,
        action: 'github_app.register',
        target: { type: 'github_app', id: String(app.appId) },
        after: { ...auditView(app), source: 'manifest' },
        result: 'ok',
      });
      this.installations.resyncInBackground();
      return this.adminPage({ registered: '1' });
    } catch (error) {
      const code = errorCode(error);
      this.logger.warn(`manifest callback refused: ${code}`);
      return this.adminPage({ error: code });
    }
  }

  /** `PUT /admin/github-app` (D1 fallback): register or replace the credentials. */
  async putCredentials(
    input: GitHubAppCredentialsRequest,
    userId: string,
    ctx: AuditContext,
  ): Promise<GitHubAppView> {
    this.store.requireCipher();
    const key = parseAppPrivateKey(input.privateKey);
    if (!key)
      throw githubAppError(
        400,
        GITHUB_APP_ERROR.invalidCredentials,
        'privateKey is not a PEM RSA private key',
      );
    const info = await this.github(() => this.client.getApp(input.appId, key));
    const sealed = this.store.seal({
      privateKey: input.privateKey,
      webhookSecret: input.webhookSecret,
      clientSecret: null,
    });
    const existing = await this.store.load();
    const fields = {
      appId: info.appId,
      slug: info.slug,
      ownerLogin: info.ownerLogin,
      privateKey: sealed.privateKey,
      webhookSecret: sealed.webhookSecret,
      hookActive: this.options.publicUrl !== null,
      // A new secret: failures under the old one say nothing about it.
      lastSignatureFailureAt: null,
    };
    const app = existing
      ? await this.prisma.gitHubApp.update({
          where: { id: GITHUB_APP_ROW_ID },
          data: fields,
        })
      : await this.prisma.gitHubApp.create({
          data: {
            id: GITHUB_APP_ROW_ID,
            ...fields,
            clientSecret: null,
            registeredById: userId,
          },
        });
    await this.audit.record({
      ...ctx,
      action: existing
        ? 'github_app.update_credentials'
        : 'github_app.register',
      target: { type: 'github_app', id: String(app.appId) },
      ...(existing ? { before: auditView(existing) } : {}),
      after: { ...auditView(app), source: 'manual' },
      result: 'ok',
    });
    this.installations.resyncInBackground();
    return this.view();
  }

  /** `POST /admin/github-app/resync` (D10). */
  async resync(ctx: AuditContext) {
    const app = await this.store.require();
    try {
      const result = await this.installations.resync();
      await this.audit.record({
        ...ctx,
        action: 'github_app.resync',
        target: { type: 'github_app', id: String(app.appId) },
        after: { ...result },
        result: 'ok',
      });
      return result;
    } catch (error) {
      await this.audit.record({
        ...ctx,
        action: 'github_app.resync',
        target: { type: 'github_app', id: String(app.appId) },
        result: 'error',
        meta: { error: errorCode(error) },
      });
      throw error;
    }
  }

  /**
   * `DELETE /admin/github-app`: forgets the registration and installations.
   * The App on GitHub stays; the admin page links to it.
   */
  async remove(ctx: AuditContext): Promise<void> {
    const app = await this.store.require();
    await this.prisma.$transaction([
      this.prisma.gitHubInstallation.deleteMany({}),
      this.prisma.gitHubApp.delete({ where: { id: GITHUB_APP_ROW_ID } }),
    ]);
    await this.audit.record({
      ...ctx,
      action: 'github_app.delete',
      target: { type: 'github_app', id: String(app.appId) },
      before: auditView(app),
      result: 'ok',
    });
    await this.health.recompute();
  }

  /** `GET /admin/github-app`. */
  async view(): Promise<GitHubAppView> {
    const app = await this.store.load();
    if (!app) return { registered: false, publicUrl: this.options.publicUrl };
    const [installations, projects] = await Promise.all([
      this.prisma.gitHubInstallation.findMany({
        orderBy: { accountLogin: 'asc' },
        include: { repos: { orderBy: { fullName: 'asc' } } },
      }),
      this.prisma.project.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, displayName: true, repo: true },
      }),
    ]);
    const byRepo = new Map<string, { id: string; displayName: string }[]>();
    for (const project of projects) {
      const key = project.repo.toLowerCase();
      const list = byRepo.get(key) ?? [];
      list.push({ id: project.id, displayName: project.displayName });
      byRepo.set(key, list);
    }
    const iso = (at: Date | null) => at?.toISOString() ?? null;
    return {
      registered: true,
      appId: app.appId,
      slug: app.slug,
      ownerLogin: app.ownerLogin,
      htmlUrl: githubAppHtmlUrl(app.slug),
      installUrl: githubAppInstallUrl(app.slug),
      hookActive: app.hookActive,
      publicUrl: this.options.publicUrl,
      signatureFailures: app.signatureFailures,
      lastDeliveryAt: iso(app.lastDeliveryAt),
      lastSignatureFailureAt: iso(app.lastSignatureFailureAt),
      hookCheckedAt: iso(app.hookCheckedAt),
      hookCheckOk: app.hookCheckOk,
      createdAt: app.createdAt.toISOString(),
      updatedAt: app.updatedAt.toISOString(),
      installations: installations.map((i) => ({
        id: i.id,
        accountLogin: i.accountLogin,
        accountType: i.accountType,
        suspended: i.suspended,
        syncedAt: i.syncedAt.toISOString(),
        repos: i.repos.map((r) => ({
          fullName: r.fullName,
          projects: byRepo.get(r.fullName) ?? [],
        })),
      })),
    };
  }

  private async requireUnregistered(): Promise<void> {
    if (await this.store.load())
      throw githubAppError(
        409,
        GITHUB_APP_ERROR.alreadyRegistered,
        'A GitHub App is already registered; delete it first',
      );
  }

  private consumeState(state: string, userId: string): void {
    this.pruneStates();
    const entry = this.states.get(state);
    if (!entry || entry.userId !== userId)
      throw githubAppError(
        400,
        GITHUB_APP_ERROR.invalidState,
        'The manifest flow state is unknown or expired; start again',
      );
    this.states.delete(state);
  }

  private pruneStates(): void {
    const now = Date.now();
    for (const [state, entry] of this.states)
      if (entry.expiresAt <= now) this.states.delete(state);
  }

  private adminPage(query: Record<string, string>): string {
    const params = new URLSearchParams(query).toString();
    return `${this.options.appUrl}${GITHUB_APP_ADMIN_PAGE}?${params}`;
  }

  private async github<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof GitHubRequestError)) throw error;
      if (error.status === 401 || error.status === 404 || error.status === 422)
        throw githubAppError(
          400,
          GITHUB_APP_ERROR.invalidCredentials,
          'GitHub refused the code or the credentials',
        );
      throw githubAppError(
        502,
        GITHUB_APP_ERROR.githubUnavailable,
        error.message,
      );
    }
  }
}

/** The stable code of a refusal, for the callback's redirect. Never a message. */
const errorCode = (error: unknown): GitHubAppErrorCode | 'internal' =>
  error instanceof GitHubAppFailure ? error.code : 'internal';
