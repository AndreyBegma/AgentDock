import { describe, expect, test } from 'bun:test';
import { PROJECT_ERROR } from '@agentdock/shared';
import type { ProjectInspection } from '@agentdock/shared/protocol';
import { ApiError } from '../api';
import {
  connectBlocker,
  describeProjectError,
  docsKindLabel,
  docsOverrideRequest,
  suggestedPathOf,
} from './format';

const inspection = (
  patch: Partial<ProjectInspection> = {},
): ProjectInspection => ({
  root: '/w/app',
  gitCommonDir: '/w/app/.git',
  isMainCheckout: true,
  remote: { url: 'git@github.com:o/app.git', forge: 'github', repo: 'o/app' },
  baseBranch: 'develop',
  baseSource: 'config',
  codeSentinelConfig: {},
  hasClaudeMd: true,
  hasAgentsMd: false,
  docs: {
    kind: 'in_repo',
    localPath: '/w/app/docs',
    repo: null,
    isGitRepo: true,
    detectedBy: 'in_repo',
    evidence: [],
    classified: { specs: [], adr: [], roadmap: [], reports: [] },
    candidates: [],
  },
  warnings: [],
  ...patch,
});

describe('connectBlocker', () => {
  test('a main GitHub checkout can be connected', () => {
    expect(connectBlocker(inspection())).toBeNull();
  });

  test('a linked worktree names the main checkout', () => {
    expect(connectBlocker(inspection({ isMainCheckout: false }))).toContain(
      '/w/app',
    );
  });

  test('a non-GitHub origin is refused', () => {
    const blocked = connectBlocker(
      inspection({
        remote: {
          url: 'git@gitlab.x:o/app.git',
          forge: 'unsupported',
          repo: null,
        },
      }),
    );
    expect(blocked).toContain('GitHub');
  });
});

describe('errors', () => {
  const error = (code: string, suggestedPath?: string) =>
    new ApiError(409, code as never, 'raw', suggestedPath);

  test('a known code is a sentence, not the raw message', () => {
    expect(describeProjectError(error(PROJECT_ERROR.runnerOffline))).toContain(
      'offline',
    );
  });

  test('an unknown code falls back to the shared wording', () => {
    expect(describeProjectError(error('something_else'))).toBe('raw');
  });

  test('the suggested path comes only with not_main_checkout', () => {
    expect(
      suggestedPathOf(error(PROJECT_ERROR.notMainCheckout, '/w/app')),
    ).toBe('/w/app');
    expect(
      suggestedPathOf(error(PROJECT_ERROR.alreadyConnected, '/w/app')),
    ).toBeUndefined();
    expect(suggestedPathOf(new Error('x'))).toBeUndefined();
  });
});

describe('docsOverrideRequest', () => {
  const form = (kind: Parameters<typeof docsOverrideRequest>[0]['kind']) => ({
    kind,
    localPath: '',
    repo: '',
  });

  test('none takes nothing', () => {
    expect(docsOverrideRequest(form('none'), '/w/app')).toEqual({
      ok: true,
      body: { kind: 'none' },
    });
  });

  test('in_repo must stay under the root', () => {
    const inside = docsOverrideRequest(
      { ...form('in_repo'), localPath: '/w/app/docs' },
      '/w/app',
    );
    expect(inside.ok).toBe(true);
    const outside = docsOverrideRequest(
      { ...form('in_repo'), localPath: '/w/app-docs' },
      '/w/app',
    );
    expect(outside.ok).toBe(false);
  });

  test('sibling_repo needs an absolute path and an optional owner/name', () => {
    expect(
      docsOverrideRequest({ ...form('sibling_repo'), localPath: 'x' }, '/w/app')
        .ok,
    ).toBe(false);
    expect(
      docsOverrideRequest(
        { kind: 'sibling_repo', localPath: '/w/app-docs', repo: 'bad' },
        '/w/app',
      ).ok,
    ).toBe(false);
    expect(
      docsOverrideRequest(
        { kind: 'sibling_repo', localPath: '/w/app-docs', repo: 'o/app-docs' },
        '/w/app',
      ),
    ).toEqual({
      ok: true,
      body: {
        kind: 'sibling_repo',
        localPath: '/w/app-docs',
        repo: 'o/app-docs',
      },
    });
  });

  test('remote_repo needs owner/name and sends no path', () => {
    expect(docsOverrideRequest(form('remote_repo'), '/w/app').ok).toBe(false);
    expect(
      docsOverrideRequest(
        { kind: 'remote_repo', localPath: '/ignored', repo: 'o/docs' },
        '/w/app',
      ),
    ).toEqual({ ok: true, body: { kind: 'remote_repo', repo: 'o/docs' } });
  });
});

test('docsKindLabel reads a missing docs row as a dash', () => {
  expect(docsKindLabel(null)).toBe('—');
  expect(docsKindLabel('in_repo')).toBe('In the repository');
});
