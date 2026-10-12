import { describe, expect, it } from 'bun:test';
import { collectorPollArgsSchema, commands } from '../protocol';
import { watchedProjectSchema } from '../protocol/projects';
import {
  buildGitHubAppManifest,
  GITHUB_APP_EVENTS,
  GITHUB_APP_NAME_MAX,
  GITHUB_APP_PERMISSIONS,
  GITHUB_LOGIN_PATTERN,
  githubManifestPostUrl,
} from './contracts';

describe('buildGitHubAppManifest (spec 27 D1, D2, D14)', () => {
  it('carries the D2 permissions, all read, the D2 events and both URLs', () => {
    const manifest = buildGitHubAppManifest({
      publicUrl: 'https://dock.example/',
      appUrl: 'https://web.example',
    });
    expect(manifest.default_permissions).toEqual({
      metadata: 'read',
      issues: 'read',
      pull_requests: 'read',
      checks: 'read',
      statuses: 'read',
      contents: 'read',
    });
    expect(manifest.default_permissions).toEqual(GITHUB_APP_PERMISSIONS);
    expect(manifest.default_events).toEqual([
      'issues',
      'pull_request',
      'pull_request_review',
      'check_suite',
      'check_run',
      'status',
      'push',
    ]);
    expect(manifest.default_events).toEqual([...GITHUB_APP_EVENTS]);
    expect(manifest.hook_attributes).toEqual({
      url: 'https://dock.example/hooks/github',
      active: true,
    });
    expect(manifest.redirect_url).toBe(
      'https://web.example/admin/integrations/github/callback',
    );
    expect(manifest.name).toBe('AgentDock dock.example');
  });

  it('sets the hook inactive without PUBLIC_URL', () => {
    const manifest = buildGitHubAppManifest({
      publicUrl: null,
      appUrl: 'http://192.168.1.5:3517',
    });
    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.redirect_url).toBe(
      'http://192.168.1.5:3517/admin/integrations/github/callback',
    );
  });

  it('keeps the name within GitHub’s limit', () => {
    const manifest = buildGitHubAppManifest({
      publicUrl: `https://${'a'.repeat(60)}.example`,
      appUrl: 'http://x',
    });
    expect(manifest.name.length).toBeLessThanOrEqual(GITHUB_APP_NAME_MAX);
  });

  it('posts to the account or the organization form', () => {
    expect(githubManifestPostUrl('s t')).toBe(
      'https://github.com/settings/apps/new?state=s%20t',
    );
    expect(githubManifestPostUrl('s', 'my-org')).toBe(
      'https://github.com/organizations/my-org/settings/apps/new?state=s',
    );
    expect(GITHUB_LOGIN_PATTERN.test('my-org')).toBe(true);
    expect(GITHUB_LOGIN_PATTERN.test('../x')).toBe(false);
    expect(GITHUB_LOGIN_PATTERN.test('-x')).toBe(false);
  });
});

describe('collector.poll (spec 27 D13)', () => {
  it('takes a project and a unique, non-empty set of known collectors', () => {
    const ok = (collectors: unknown) =>
      collectorPollArgsSchema.safeParse({ projectId: 'p', collectors }).success;
    expect(ok(['issues'])).toBe(true);
    expect(ok(['prs', 'worktrees'])).toBe(true);
    expect(ok([])).toBe(false);
    expect(ok(['prs', 'prs'])).toBe(false);
    expect(ok(['fleet'])).toBe(false);
    expect(
      collectorPollArgsSchema.safeParse({
        projectId: 'p',
        collectors: ['prs'],
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('is in the allowlist, admin-only, with its runner handler', () => {
    expect(Object.hasOwn(commands, 'collector.poll')).toBe(true);
    expect(commands['collector.poll'].minRole).toBe('admin');
  });
});

describe('watch list githubApp (spec 27 D12)', () => {
  it('is optional, so an older API’s list still parses', () => {
    expect(watchedProjectSchema.parse({ id: 'p', root: '/r' })).toEqual({
      id: 'p',
      root: '/r',
    });
    expect(
      watchedProjectSchema.parse({ id: 'p', root: '/r', githubApp: 'healthy' })
        .githubApp,
    ).toBe('healthy');
    expect(
      watchedProjectSchema.safeParse({
        id: 'p',
        root: '/r',
        githubApp: 'maybe',
      }).success,
    ).toBe(false);
  });
});
