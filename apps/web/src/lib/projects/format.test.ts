import { describe, expect, test } from 'bun:test';
import { PROJECT_ERROR } from '@agentdock/shared';
import type { ProjectInspection } from '@agentdock/shared/protocol';
import { ApiError } from '../api';
import {
  connectBlocker,
  describeProjectError,
  docsKindLabel,
  docsOverrideRequest,
  githubAppState,
  noOnlineRunnerCopy,
  specFolderError,
  specFolderOf,
  suggestedPathOf,
} from './format';

describe('githubAppState', () => {
  test('one state: not covered wins, then healthy, then needs attention', () => {
    expect(githubAppState({ covered: false, state: 'healthy' }).label).toBe(
      'Not covered',
    );
    expect(githubAppState({ covered: true, state: 'healthy' })).toEqual({
      label: 'Healthy',
      tone: 'ok',
    });
    expect(githubAppState({ covered: true, state: 'unhealthy' }).tone).toBe(
      'warn',
    );
  });
});

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

describe('noOnlineRunnerCopy', () => {
  test('none paired: pair one first, with a link', () => {
    expect(noOnlineRunnerCopy({ kind: 'none' })).toMatchObject({
      title: 'No runner is paired.',
      href: '/admin/runners',
      cta: 'Pair a runner',
    });
  });

  test('paired but offline: names it and the command to start it', () => {
    expect(
      noOnlineRunnerCopy({
        kind: 'offline',
        runners: [{ id: 'r1', name: 'laptop', hostname: 'laptop.local' }],
      }),
    ).toMatchObject({
      title: 'laptop is offline.',
      body: 'Start it on that machine:',
      command: 'agentdock-runner run',
    });
    expect(
      noOnlineRunnerCopy({
        kind: 'offline',
        runners: [
          { id: 'a', name: 'laptop', hostname: null },
          { id: 'b', name: 'server', hostname: null },
        ],
      })?.title,
    ).toBe('laptop, server are offline.');
  });

  test('nothing while a runner is online', () => {
    expect(noOnlineRunnerCopy({ kind: 'online', online: 1 })).toBeNull();
    expect(noOnlineRunnerCopy({ kind: 'unknown' })).toBeNull();
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

  test('runner offline says how to start it', () => {
    expect(describeProjectError(error(PROJECT_ERROR.runnerOffline))).toContain(
      'agentdock-runner run',
    );
  });

  test("runner error carries the server's message, without the command name", () => {
    const failed = new ApiError(
      502,
      PROJECT_ERROR.runnerError as never,
      'project.inspect: git exited with 128',
    );
    expect(describeProjectError(failed)).toBe(
      'The runner could not complete that: git exited with 128',
    );
  });

  test('path not allowed names the rule, or falls back to the server message', () => {
    const refused = (message: string) =>
      new ApiError(403, PROJECT_ERROR.pathNotAllowed as never, message);
    expect(
      describeProjectError(
        refused('/w/app is not a registered root of project p1'),
      ),
    ).toContain("not registered this path as the project's root");
    expect(describeProjectError(refused('outside the allowed roots'))).toBe(
      'The runner does not allow that path: outside the allowed roots',
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

  test('remote_repo needs owner/name and takes an optional local clone (#379)', () => {
    expect(docsOverrideRequest(form('remote_repo'), '/w/app').ok).toBe(false);
    expect(
      docsOverrideRequest(
        { kind: 'remote_repo', localPath: '', repo: 'o/docs' },
        '/w/app',
      ),
    ).toEqual({ ok: true, body: { kind: 'remote_repo', repo: 'o/docs' } });
    expect(
      docsOverrideRequest(
        { kind: 'remote_repo', localPath: '/clones/docs', repo: 'o/docs' },
        '/w/app',
      ),
    ).toEqual({
      ok: true,
      body: { kind: 'remote_repo', repo: 'o/docs', localPath: '/clones/docs' },
    });
    expect(
      docsOverrideRequest(
        { kind: 'remote_repo', localPath: 'clones/docs', repo: 'o/docs' },
        '/w/app',
      ).ok,
    ).toBe(false);
  });

  test('carries the Spec folder, blank clearing it (#379)', () => {
    const sibling = {
      kind: 'sibling_repo' as const,
      localPath: '/w/app-docs',
      repo: '',
    };
    expect(
      docsOverrideRequest({ ...sibling, specDir: ' prs/ ' }, '/w/app'),
    ).toEqual({
      ok: true,
      body: { kind: 'sibling_repo', localPath: '/w/app-docs', specDir: 'prs' },
    });
    expect(docsOverrideRequest({ ...sibling, specDir: '' }, '/w/app')).toEqual({
      ok: true,
      body: { kind: 'sibling_repo', localPath: '/w/app-docs', specDir: null },
    });
    expect(
      docsOverrideRequest({ ...sibling, specDir: '../prs' }, '/w/app').ok,
    ).toBe(false);
  });
});

describe('Spec folder (#379)', () => {
  test('is a relative path inside the docs root', () => {
    expect(specFolderError('prs')).toBeNull();
    expect(specFolderError('docs/specs/')).toBeNull();
    expect(specFolderError('')).toBeNull();
    for (const bad of ['/prs', '../prs', 'a/./b', 'a//b', 'a\\b']) {
      expect(specFolderError(bad)).not.toBeNull();
    }
  });

  test('starts from the stored folder, else the classified specs folder', () => {
    const docs = {
      specDir: null,
      classified: {
        specs: ['specs', 'old/specs'],
        adr: [],
        roadmap: [],
        reports: [],
      },
    } as unknown as Parameters<typeof specFolderOf>[0];
    expect(specFolderOf(docs)).toBe('specs');
    expect(specFolderOf({ ...docs, specDir: 'prs' } as typeof docs)).toBe(
      'prs',
    );
    expect(specFolderOf(null)).toBe('');
  });
});

test('docsKindLabel reads a missing docs row as a dash', () => {
  expect(docsKindLabel(null)).toBe('—');
  expect(docsKindLabel('in_repo')).toBe('In the repository');
});
