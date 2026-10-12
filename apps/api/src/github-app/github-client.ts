import type { KeyObject } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  GITHUB_APP_OPTIONS,
  type GitHubAppOptions,
} from './github-app-options';
import { signAppJwt } from './github-jwt';

/**
 * The only server-side GitHub API use (D4): reading App metadata. Nothing
 * here writes to GitHub — issue and PR data keep coming from the runner's
 * `gh` (ADR-0004). Endpoints per GitHub's REST docs, API version 2022-11-28.
 */

const API_VERSION = '2022-11-28';
const PER_PAGE = 100;
/** 100 pages × 100: far beyond one instance's installations or repos. */
const MAX_PAGES = 100;

/** GitHub did not answer, or answered an error. The message never holds a secret. */
export class GitHubRequestError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubRequestError';
  }
}

/** `POST /app-manifests/{code}/conversions` — what the manifest flow returns (D1). */
export interface ManifestConversion {
  appId: number;
  slug: string;
  ownerLogin: string;
  privateKey: string;
  webhookSecret: string;
  clientSecret: string | null;
}

export interface AppInfo {
  appId: number;
  slug: string;
  ownerLogin: string;
}

export interface InstallationInfo {
  id: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
}

export interface InstallationRepo {
  repoId: bigint;
  /** Lower-cased (D7). */
  fullName: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

const malformed = (what: string) =>
  new GitHubRequestError(null, `GitHub answered a malformed ${what}`);

@Injectable()
export class GitHubAppClient {
  constructor(
    @Inject(GITHUB_APP_OPTIONS) private readonly options: GitHubAppOptions,
  ) {}

  /** D1: exchanges the manifest flow's one-time code. Unauthenticated, outbound only. */
  async convertManifest(code: string): Promise<ManifestConversion> {
    const { json: j } = await this.request(
      'POST',
      `/app-manifests/${encodeURIComponent(code)}/conversions`,
      null,
    );
    if (!isRecord(j)) throw malformed('conversion');
    const appId = int(j.id);
    if (appId === null) throw malformed('conversion');
    const slug = str(j.slug);
    const ownerLogin = str(isRecord(j.owner) ? j.owner.login : null);
    const privateKey = str(j.pem);
    const webhookSecret = str(j.webhook_secret);
    if (!slug || !ownerLogin || !privateKey || !webhookSecret)
      throw malformed('conversion');
    return {
      appId,
      slug,
      ownerLogin,
      privateKey,
      webhookSecret,
      clientSecret: str(j.client_secret),
    };
  }

  /** `GET /app` — proves the credentials and reads the slug and owner. */
  async getApp(appId: number, key: KeyObject): Promise<AppInfo> {
    const { json } = await this.request('GET', '/app', this.jwt(appId, key));
    const id = int(isRecord(json) ? json.id : null);
    if (!isRecord(json) || id === null) throw malformed('app');
    const slug = str(json.slug);
    const ownerLogin = str(isRecord(json.owner) ? json.owner.login : null);
    if (!slug || !ownerLogin) throw malformed('app');
    return { appId: id, slug, ownerLogin };
  }

  /** `GET /app/installations`, every page. */
  async listInstallations(
    appId: number,
    key: KeyObject,
  ): Promise<InstallationInfo[]> {
    const jwt = this.jwt(appId, key);
    const out: InstallationInfo[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { json } = await this.request(
        'GET',
        `/app/installations?per_page=${PER_PAGE}&page=${page}`,
        jwt,
      );
      if (!Array.isArray(json)) throw malformed('installation list');
      for (const item of json) {
        const id = int(isRecord(item) ? item.id : null);
        if (!isRecord(item) || id === null) continue;
        const account = isRecord(item.account) ? item.account : {};
        out.push({
          id,
          accountLogin: str(account.login) ?? '',
          accountType: str(account.type) ?? 'User',
          suspended:
            item.suspended_at !== null && item.suspended_at !== undefined,
        });
      }
      if (json.length < PER_PAGE) break;
    }
    return out;
  }

  /** An installation token, then `GET /installation/repositories`, every page. */
  async listInstallationRepos(
    appId: number,
    key: KeyObject,
    installationId: number,
  ): Promise<InstallationRepo[]> {
    const tokenBody = await this.request(
      'POST',
      `/app/installations/${installationId}/access_tokens`,
      this.jwt(appId, key),
    );
    const token = str(isRecord(tokenBody.json) ? tokenBody.json.token : null);
    if (!token) throw malformed('installation token');

    const out: InstallationRepo[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { json } = await this.request(
        'GET',
        `/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
        `token ${token}`,
      );
      const repos = isRecord(json) ? json.repositories : null;
      if (!Array.isArray(repos)) throw malformed('repository list');
      for (const repo of repos) {
        const id = int(isRecord(repo) ? repo.id : null);
        const fullName = str(isRecord(repo) ? repo.full_name : null);
        if (id === null || !fullName) continue;
        out.push({ repoId: BigInt(id), fullName: fullName.toLowerCase() });
      }
      if (repos.length < PER_PAGE) break;
    }
    return out;
  }

  /**
   * D11: `GET /app/hook/deliveries?per_page=1` — whether GitHub's latest
   * delivery attempt got a 2xx. Null: GitHub has made no delivery yet.
   */
  async latestHookDeliveryOk(
    appId: number,
    key: KeyObject,
  ): Promise<boolean | null> {
    const { json } = await this.request(
      'GET',
      '/app/hook/deliveries?per_page=1',
      this.jwt(appId, key),
    );
    if (!Array.isArray(json)) throw malformed('delivery list');
    if (json.length === 0) return null;
    const status = int(isRecord(json[0]) ? json[0].status_code : null);
    return status !== null && status >= 200 && status < 300;
  }

  private jwt(appId: number, key: KeyObject): string {
    return `Bearer ${signAppJwt(appId, key)}`;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    authorization: string | null,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'AgentDock',
    };
    if (authorization) headers.Authorization = authorization;
    let response: Response;
    try {
      response = await this.options.fetch(`${this.options.apiBase}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch {
      throw new GitHubRequestError(
        null,
        `GitHub did not answer ${method} ${pathOnly(path)}`,
      );
    }
    if (!response.ok) {
      // The body may echo request details; only the status is kept.
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubRequestError(
        response.status,
        `GitHub answered ${response.status} to ${method} ${pathOnly(path)}`,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw malformed('response');
    }
    return { status: response.status, json };
  }
}

/** A path without its query, and without the manifest code (a one-time secret). */
const pathOnly = (path: string): string =>
  path.split('?')[0].replace(/^\/app-manifests\/[^/]+/, '/app-manifests/:code');
