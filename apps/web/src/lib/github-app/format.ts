import {
  GITHUB_APP_ERROR,
  type GITHUB_APP_EVENTS,
  type GITHUB_APP_PERMISSIONS,
  GITHUB_HOOK_PATH,
  GITHUB_LOGIN_PATTERN,
  type GitHubAppCredentialsRequest,
  type GitHubAppView,
  type GitHubHealthReason,
} from '@nautelle/shared';
import { ApiError, describeError } from '../api';
import {
  ENCRYPTION_KEY_REMEDY,
  PUBLIC_URL_REMEDY,
} from '../prerequisites/copy';

type Registered = Extract<GitHubAppView, { registered: true }>;

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export const HEALTH_TONE: Record<'healthy' | 'unhealthy', Tone> = {
  healthy: 'ok',
  unhealthy: 'warn',
};

/** Why a project is `unhealthy`, as a sentence an admin can act on. */
export const HEALTH_REASON_LABEL: Record<GitHubHealthReason, string> = {
  not_registered: 'No GitHub App is registered yet.',
  hook_inactive: `The App’s webhook is inactive, so GitHub cannot reach this server. ${PUBLIC_URL_REMEDY}`,
  not_covered: 'The App is not installed on this repository.',
  installation_suspended: 'The App’s installation is suspended.',
  signature_failure:
    'GitHub deliveries failed signature checks — the webhook secret does not match.',
  no_recent_delivery:
    'No delivery from GitHub for an hour — it may not be able to reach this server.',
};

const ERROR_SENTENCE: Record<string, string> = {
  [GITHUB_APP_ERROR.invalidState]:
    'The registration link expired or was not started here. Start again.',
  [GITHUB_APP_ERROR.alreadyRegistered]:
    'An App is already registered. Delete it before registering another.',
  [GITHUB_APP_ERROR.encryptionKeyMissing]: `The server has no APP_ENCRYPTION_KEY, so it cannot store the App’s secrets. ${ENCRYPTION_KEY_REMEDY}`,
  [GITHUB_APP_ERROR.invalidCredentials]:
    'GitHub did not accept these credentials. Check the App ID and the private key.',
  [GITHUB_APP_ERROR.githubUnavailable]:
    'GitHub could not be reached. Try again in a minute.',
  [GITHUB_APP_ERROR.notRegistered]: 'No GitHub App is registered.',
  [GITHUB_APP_ERROR.notFound]: 'Not found.',
  internal: 'Registration failed on the server. Check the API log.',
};

/** A sentence for the `?error=<code>` the API’s callback redirects with. */
export function describeCallbackError(code: string): string {
  return ERROR_SENTENCE[code] ?? 'Registration failed.';
}

export function describeGitHubAppError(error: unknown): string {
  if (error instanceof ApiError) {
    const sentence = ERROR_SENTENCE[String(error.code)];
    if (sentence) return sentence;
    if (error.status === 403) return 'You do not have access to this.';
  }
  return describeError(error);
}

/**
 * The API URL the callback page hands the browser to, or null when GitHub’s
 * redirect carries no `code` / `state`. Both are passed on untouched.
 */
export function apiCallbackUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return null;
  return `/api/admin/github-app/callback?${new URLSearchParams({ code, state })}`;
}

/** An organization login, or null for a personal account; undefined = invalid. */
export function parseOwner(input: string): string | null | undefined {
  const owner = input.trim();
  if (owner === '') return null;
  return GITHUB_LOGIN_PATTERN.test(owner) ? owner : undefined;
}

export interface CredentialsForm {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
}

export const emptyCredentialsForm = (): CredentialsForm => ({
  appId: '',
  slug: '',
  privateKey: '',
  webhookSecret: '',
});

/** What is wrong with the form, and the field it belongs under. */
export interface CredentialsProblem {
  field: keyof CredentialsForm;
  text: string;
}

export function credentialsProblem(
  form: CredentialsForm,
): CredentialsProblem | null {
  if (!/^\d+$/.test(form.appId.trim()))
    return { field: 'appId', text: 'The App ID is a number.' };
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(form.slug.trim())) {
    return {
      field: 'slug',
      text: 'The slug is the App’s name in its URL: letters, digits, hyphens.',
    };
  }
  if (!form.privateKey.includes('BEGIN') || !form.privateKey.includes('KEY')) {
    return {
      field: 'privateKey',
      text: 'The private key is the PEM file GitHub offered for download.',
    };
  }
  if (form.webhookSecret.trim() === '')
    return { field: 'webhookSecret', text: 'The webhook secret is required.' };
  return null;
}

/**
 * Where a server refusal of the manual credentials belongs: GitHub refusing
 * the JWT points at the key; anything else is about the whole form.
 */
export function credentialsErrorField(
  error: unknown,
): keyof CredentialsForm | null {
  return error instanceof ApiError &&
    String(error.code) === GITHUB_APP_ERROR.invalidCredentials
    ? 'privateKey'
    : null;
}

/** The URL GitHub delivers to, or null without a `PUBLIC_URL` (D14). */
export const githubWebhookUrl = (publicUrl: string | null): string | null =>
  publicUrl ? `${publicUrl.replace(/\/+$/, '')}${GITHUB_HOOK_PATH}` : null;

/**
 * The App's Advanced settings page, where GitHub lists Recent deliveries and
 * why each failed. An App owned by an organization lives under the
 * organization; the view has no owner type, so an installation on the owner's
 * account tells it, else the personal path.
 */
export function githubAppDeliveriesUrl(
  app: Pick<Registered, 'slug' | 'ownerLogin' | 'installations'>,
): string {
  const owner = app.installations.find(
    (i) => i.accountLogin.toLowerCase() === app.ownerLogin.toLowerCase(),
  );
  const slug = encodeURIComponent(app.slug);
  return owner?.accountType === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(app.ownerLogin)}/settings/apps/${slug}/advanced`
    : `https://github.com/settings/apps/${slug}/advanced`;
}

/** What the manual card lists, in GitHub's own words (spec D2). */
export const PERMISSION_LABEL: Record<
  keyof typeof GITHUB_APP_PERMISSIONS,
  string
> = {
  metadata: 'Metadata',
  issues: 'Issues',
  pull_requests: 'Pull requests',
  checks: 'Checks',
  statuses: 'Commit statuses',
  contents: 'Contents',
};

export const EVENT_LABEL: Record<(typeof GITHUB_APP_EVENTS)[number], string> = {
  issues: 'Issues',
  pull_request: 'Pull request',
  pull_request_review: 'Pull request review',
  check_suite: 'Check suite',
  check_run: 'Check run',
  status: 'Status',
  push: 'Push',
};

export const toCredentialsRequest = (
  form: CredentialsForm,
): GitHubAppCredentialsRequest => ({
  appId: Number(form.appId.trim()),
  slug: form.slug.trim(),
  privateKey: form.privateKey.trim(),
  webhookSecret: form.webhookSecret.trim(),
});
