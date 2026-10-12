import { describe, expect, test } from 'bun:test';
import { GITHUB_HEALTH_REASONS } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  apiCallbackUrl,
  credentialsProblem,
  describeCallbackError,
  describeGitHubAppError,
  emptyCredentialsForm,
  HEALTH_REASON_LABEL,
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

  test('each field is checked', () => {
    expect(credentialsProblem(emptyCredentialsForm())).toContain('App ID');
    expect(credentialsProblem({ ...valid, slug: '' })).toContain('slug');
    expect(credentialsProblem({ ...valid, privateKey: 'x' })).toContain('PEM');
    expect(credentialsProblem({ ...valid, webhookSecret: ' ' })).toContain(
      'secret',
    );
  });
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
