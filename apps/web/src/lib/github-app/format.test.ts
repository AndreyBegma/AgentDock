import { describe, expect, test } from 'bun:test';
import {
  GITHUB_APP_EVENTS,
  GITHUB_APP_PERMISSIONS,
  GITHUB_HEALTH_REASONS,
} from '@nautelle/shared';
import { ApiError } from '../api';
import {
  apiCallbackUrl,
  credentialsErrorField,
  credentialsProblem,
  describeCallbackError,
  describeGitHubAppError,
  EVENT_LABEL,
  emptyCredentialsForm,
  githubAppDeliveriesUrl,
  githubWebhookUrl,
  HEALTH_REASON_LABEL,
  PERMISSION_LABEL,
  parseOwner,
  toCredentialsRequest,
} from './format';

describe('apiCallbackUrl', () => {
  test('passes code and state on to the API, encoded', () => {
    expect(apiCallbackUrl('?code=a%2Fb&state=s1')).toBe(
      '/api/admin/github-app/callback?code=a%2Fb&state=s1',
    );
  });

  test('is null without a code or a state', () => {
    expect(apiCallbackUrl('')).toBeNull();
    expect(apiCallbackUrl('?code=x')).toBeNull();
    expect(apiCallbackUrl('?state=x')).toBeNull();
  });
});

describe('parseOwner', () => {
  test('empty means a personal account', () => {
    expect(parseOwner('  ')).toBeNull();
  });
  test('a login is trimmed; an invalid one is undefined', () => {
    expect(parseOwner(' my-org ')).toBe('my-org');
    expect(parseOwner('-bad')).toBeUndefined();
    expect(parseOwner('a b')).toBeUndefined();
  });
});

describe('credentials form', () => {
  const valid = {
    appId: ' 123 ',
    slug: 'agentdock-x',
    privateKey:
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    webhookSecret: 's3cret',
  };

  test('a valid form has no problem and converts to numbers and trimmed text', () => {
    expect(credentialsProblem(valid)).toBeNull();
    expect(toCredentialsRequest(valid).appId).toBe(123);
  });

  test('each problem names the field it belongs under', () => {
    expect(credentialsProblem(emptyCredentialsForm())).toMatchObject({
      field: 'appId',
      text: expect.stringContaining('App ID'),
    });
    expect(credentialsProblem({ ...valid, slug: '' })?.field).toBe('slug');
    expect(credentialsProblem({ ...valid, privateKey: 'x' })).toMatchObject({
      field: 'privateKey',
      text: expect.stringContaining('PEM'),
    });
    expect(credentialsProblem({ ...valid, webhookSecret: ' ' })?.field).toBe(
      'webhookSecret',
    );
  });

  test('GitHub refusing the credentials points at the key; other errors at the form', () => {
    expect(
      credentialsErrorField(
        new ApiError(400, 'invalid_credentials' as never, 'x'),
      ),
    ).toBe('privateKey');
    expect(
      credentialsErrorField(
        new ApiError(409, 'encryption_key_missing' as never, 'x'),
      ),
    ).toBeNull();
    expect(credentialsErrorField(new Error('offline'))).toBeNull();
  });
});

describe('webhook and deliveries URLs', () => {
  test('the webhook URL is absolute under PUBLIC_URL, or null without it', () => {
    expect(githubWebhookUrl('https://dock.example/')).toBe(
      'https://dock.example/hooks/github',
    );
    expect(githubWebhookUrl(null)).toBeNull();
  });

  const app = (accountType: string, accountLogin = 'acme') => ({
    slug: 'agentdock-x',
    ownerLogin: 'Acme',
    installations: [
      {
        id: 1,
        accountLogin,
        accountType,
        suspended: false,
        syncedAt: '',
        repos: [],
      },
    ],
  });

  test('an App owned by an organization is under the organization’s settings', () => {
    expect(githubAppDeliveriesUrl(app('Organization'))).toBe(
      'https://github.com/organizations/Acme/settings/apps/agentdock-x/advanced',
    );
  });

  test('a personal App, or one with no installation on its owner, is under the user’s settings', () => {
    expect(githubAppDeliveriesUrl(app('User'))).toBe(
      'https://github.com/settings/apps/agentdock-x/advanced',
    );
    expect(githubAppDeliveriesUrl(app('Organization', 'other'))).toBe(
      'https://github.com/settings/apps/agentdock-x/advanced',
    );
  });
});

test('every permission and event the App asks for has a label', () => {
  for (const key of Object.keys(GITHUB_APP_PERMISSIONS)) {
    expect(PERMISSION_LABEL[key as keyof typeof PERMISSION_LABEL]).toBeTruthy();
  }
  for (const event of GITHUB_APP_EVENTS) {
    expect(EVENT_LABEL[event]).toBeTruthy();
  }
});

test('the missing-key error says how to set the key (R4)', () => {
  const text = describeGitHubAppError(
    new ApiError(409, 'encryption_key_missing' as never, 'x'),
  );
  expect(text).toContain('APP_ENCRYPTION_KEY=');
  expect(text).toContain('openssl rand -base64 32');
  expect(text).toContain('restart the API');
});

describe('errors', () => {
  test('every callback error code has its own sentence', () => {
    for (const code of [
      'invalid_state',
      'already_registered',
      'encryption_key_missing',
      'invalid_credentials',
      'github_unavailable',
      'internal',
    ]) {
      expect(describeCallbackError(code)).not.toBe('Registration failed.');
    }
    expect(describeCallbackError('weird')).toBe('Registration failed.');
  });

  test('a route error code maps to a sentence', () => {
    const error = new ApiError(400, 'invalid_credentials' as never, 'x');
    expect(describeGitHubAppError(error)).toContain('credentials');
  });
});

test('every health reason is explained', () => {
  for (const reason of GITHUB_HEALTH_REASONS) {
    expect(HEALTH_REASON_LABEL[reason].length).toBeGreaterThan(10);
  }
});
