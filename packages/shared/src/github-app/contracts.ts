import type { GitHubAppHealth } from '../protocol/projects';

/**
 * HTTP contracts, limits and codes of the GitHub App integration
 * (docs/specs/27-github-app.md): `POST /hooks/github`, `/admin/github-app*`
 * and `/projects/:projectId/github-app`.
 */

// ─── The App (D1, D2) ───────────────────────────────────────────────────────

/** D2: every permission the App asks for — all read-only. */
export const GITHUB_APP_PERMISSIONS = {
  metadata: 'read',
  issues: 'read',
  pull_requests: 'read',
  checks: 'read',
  statuses: 'read',
  contents: 'read',
} as const;

/** D2: the events the App subscribes to. `installation*` and `ping` come unasked. */
export const GITHUB_APP_EVENTS = [
  'issues',
  'pull_request',
  'pull_request_review',
  'check_suite',
  'check_run',
  'status',
  'push',
] as const;

/** D5: the public route GitHub delivers to. */
export const GITHUB_HOOK_PATH = '/hooks/github';
/** D6: largest delivery AgentDock accepts (GitHub's own cap is 25 MB). */
export const GITHUB_HOOK_BODY_MAX_BYTES = 5 * 1024 * 1024;
/** D1: the web page GitHub sends the browser back to after the manifest flow. */
export const GITHUB_APP_CALLBACK_PAGE = '/admin/integrations/github/callback';
/** The admin page; the API's callback redirects here. */
export const GITHUB_APP_ADMIN_PAGE = '/admin/integrations/github';
/** GitHub caps an App's name at 34 characters. */
export const GITHUB_APP_NAME_MAX = 34;

export const GITHUB_HEADERS = {
  /** `sha256=<hex>` of `HMAC-SHA256(webhook secret, raw body)`. */
  signature: 'X-Hub-Signature-256',
  /** A GUID per delivery; a redelivery keeps it. */
  delivery: 'X-GitHub-Delivery',
  /** The event name (`issues`, `push`, …). */
  event: 'X-GitHub-Event',
} as const;

// ─── Timing (D8, D11, D17) ──────────────────────────────────────────────────

/** D8: polls for one project within this window are sent as one. */
export const GITHUB_POLL_DEBOUNCE_MS = 4_000;
/** D11: a delivery or a good resync check younger than this keeps a project healthy. */
export const GITHUB_HEALTH_WINDOW_MS = 60 * 60 * 1000;
/** D11: health is recomputed this often. */
export const GITHUB_HEALTH_INTERVAL_MS = 5 * 60 * 1000;
/** D17: `github_deliveries` are kept this many days. */
export const GITHUB_DELIVERY_RETENTION_DAYS = 14;

// ─── Manifest (D1) ──────────────────────────────────────────────────────────

/** What GitHub's manifest flow receives (`POST https://github.com/settings/apps/new`). */
export interface GitHubAppManifest {
  name: string;
  url: string;
  description: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: false;
  default_permissions: Record<keyof typeof GITHUB_APP_PERMISSIONS, 'read'>;
  default_events: string[];
}

export interface GitHubManifestInput {
  /** Public HTTPS base GitHub can reach; absent → the hook is inactive (D14). */
  publicUrl: string | null;
  /** Browser-facing base of the web app. */
  appUrl: string;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** D1/D2/D14: the manifest for this instance. Pure. */
export const buildGitHubAppManifest = (
  input: GitHubManifestInput,
): GitHubAppManifest => {
  const appUrl = trimSlash(input.appUrl);
  const publicUrl = input.publicUrl ? trimSlash(input.publicUrl) : null;
  const name = `AgentDock ${hostOf(publicUrl ?? appUrl)}`.slice(
    0,
    GITHUB_APP_NAME_MAX,
  );
  return {
    name,
    url: appUrl,
    description:
      'Read-only events for AgentDock: issues, pull requests, checks.',
    hook_attributes: {
      // GitHub requires a URL even for an inactive hook.
      url: `${publicUrl ?? appUrl}${GITHUB_HOOK_PATH}`,
      active: publicUrl !== null,
    },
    redirect_url: `${appUrl}${GITHUB_APP_CALLBACK_PAGE}`,
    public: false,
    default_permissions: { ...GITHUB_APP_PERMISSIONS },
    default_events: [...GITHUB_APP_EVENTS],
  };
};

/** Where the browser posts the manifest: a personal account, or an organization. */
export const githubManifestPostUrl = (
  state: string,
  owner?: string | null,
): string => {
  const base = owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  return `${base}?state=${encodeURIComponent(state)}`;
};

/** GitHub organization / user login: alphanumerics and single hyphens, ≤ 39. */
export const GITHUB_LOGIN_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

// ─── Errors ─────────────────────────────────────────────────────────────────

export const GITHUB_APP_ERROR = {
  notFound: 'not_found',
  /** No App is registered. */
  notRegistered: 'not_registered',
  /** An App is already registered; delete it first. */
  alreadyRegistered: 'already_registered',
  /** D3 (#22). */
  encryptionKeyMissing: 'encryption_key_missing',
  /** The manifest flow's `state` is unknown, expired or someone else's. */
  invalidState: 'invalid_state',
  /** GitHub refused or did not answer. */
  githubUnavailable: 'github_unavailable',
  /** The private key is not a PEM RSA key, or GitHub refused the JWT. */
  invalidCredentials: 'invalid_credentials',
} as const;
export type GitHubAppErrorCode =
  (typeof GITHUB_APP_ERROR)[keyof typeof GITHUB_APP_ERROR];

export interface GitHubAppErrorBody {
  statusCode: number;
  error: GitHubAppErrorCode;
  message: string;
}

// ─── Hook (D5–D7) ───────────────────────────────────────────────────────────

/** `POST /hooks/github` → 200. */
export interface GitHubHookAnswer {
  status: 'accepted' | 'duplicate' | 'ignored';
}

// ─── Health (D10, D11) ──────────────────────────────────────────────────────

/** Why a project is `unhealthy`, the first that applies. */
export const GITHUB_HEALTH_REASONS = [
  'not_registered',
  'hook_inactive',
  'not_covered',
  'installation_suspended',
  'signature_failure',
  'no_recent_delivery',
] as const;
export type GitHubHealthReason = (typeof GITHUB_HEALTH_REASONS)[number];

/** `GET /projects/:projectId/github-app`. */
export interface GitHubProjectAppStatus {
  covered: boolean;
  state: GitHubAppHealth;
  /** null when `healthy`. */
  reason: GitHubHealthReason | null;
  /** ISO time of the last recompute; null before the first. */
  checkedAt: string | null;
}

// ─── Admin (D1, D10, D15) ───────────────────────────────────────────────────

/** `POST /admin/github-app/manifest`. */
export interface GitHubManifestRequest {
  /** Organization login; absent → the admin's personal account. */
  owner?: string;
}

/** The browser form the admin page submits to GitHub. */
export interface GitHubManifestResponse {
  postUrl: string;
  manifest: GitHubAppManifest;
  state: string;
}

/** `PUT /admin/github-app`: an App created by hand (D1 fallback). */
export interface GitHubAppCredentialsRequest {
  appId: number;
  slug: string;
  /** PEM of the App's RSA private key. */
  privateKey: string;
  webhookSecret: string;
}

export interface GitHubInstallationRepoView {
  fullName: string;
  /** Projects whose repo is this one (D7). */
  projects: { id: string; displayName: string }[];
}

export interface GitHubInstallationView {
  id: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
  syncedAt: string;
  repos: GitHubInstallationRepoView[];
}

/** `GET /admin/github-app`. Secrets never leave the API. */
export type GitHubAppView =
  | { registered: false; publicUrl: string | null }
  | {
      registered: true;
      appId: number;
      slug: string;
      ownerLogin: string;
      htmlUrl: string;
      installUrl: string;
      hookActive: boolean;
      /** The configured `PUBLIC_URL`; null → the hook cannot be reached (D14). */
      publicUrl: string | null;
      signatureFailures: number;
      lastDeliveryAt: string | null;
      lastSignatureFailureAt: string | null;
      hookCheckedAt: string | null;
      hookCheckOk: boolean | null;
      createdAt: string;
      updatedAt: string;
      installations: GitHubInstallationView[];
    };

/** `POST /admin/github-app/resync`. */
export interface GitHubResyncResult {
  installations: number;
  repos: number;
  hookCheckOk: boolean | null;
}

export const githubAppHtmlUrl = (slug: string): string =>
  `https://github.com/apps/${encodeURIComponent(slug)}`;

export const githubAppInstallUrl = (slug: string): string =>
  `${githubAppHtmlUrl(slug)}/installations/new`;
