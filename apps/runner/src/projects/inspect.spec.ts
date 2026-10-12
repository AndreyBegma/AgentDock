import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { join } from 'node:path';
import { projectInspectionSchema } from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { Exec } from '../detect/exec';
import {
  gitWithFakeGh,
  REAL_PROCESS_TIMEOUT_MS,
  workspace,
} from '../testing/projects';
import { inspectProject, refreshProject } from './inspect';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS);

let ws: ReturnType<typeof workspace>;
afterEach(() => ws?.cleanup());

const inspect = async (path: string, exec?: Exec) => {
  const result = await inspectProject(path, {
    exec: exec ?? gitWithFakeGh(ws.git),
  });
  return projectInspectionSchema.parse(result);
};

const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof CommandFailure) return error.code;
    throw error;
  }
  throw new Error('expected a CommandFailure');
};

describe('project.inspect', () => {
  it('reports a GitHub main checkout: repo, base from config, config snapshot, docs', async () => {
    ws = workspace();
    const root = await ws.repo('x', 'git@github.com:acme/x.git');
    ws.files({
      'x/.code-analyzer-config.json': JSON.stringify({
        orchestrator: { base: 'develop', checks: ['bun run test'] },
        other: true,
      }),
      'x/CLAUDE.md': '# x',
      'x/docs/specs/': '',
    });

    const result = await inspect(root);

    expect(result).toEqual({
      root,
      gitCommonDir: join(root, '.git'),
      isMainCheckout: true,
      remote: {
        url: 'git@github.com:acme/x.git',
        forge: 'github',
        repo: 'acme/x',
      },
      baseBranch: 'develop',
      baseSource: 'config',
      codeSentinelConfig: {
        orchestrator: { base: 'develop', checks: ['bun run test'] },
      },
      hasClaudeMd: true,
      hasAgentsMd: false,
      docs: expect.objectContaining({
        kind: 'in_repo',
        localPath: join(root, 'docs'),
        detectedBy: 'in_repo',
      }),
      warnings: [],
    });
  });

  it('takes the base from origin/HEAD, then gh, then main', async () => {
    ws = workspace();
    const root = await ws.repo('x', 'https://github.com/acme/x.git');

    expect(await inspect(root)).toMatchObject({
      baseBranch: 'main',
      baseSource: 'default',
    });

    const gh = gitWithFakeGh(ws.git, {
      'repo view acme/x --json defaultBranchRef --jq .defaultBranchRef.name':
        'trunk',
    });
    expect(await inspect(root, gh)).toMatchObject({
      baseBranch: 'trunk',
      baseSource: 'gh',
    });

    await ws.run(
      root,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/release',
    );
    expect(await inspect(root, gh)).toMatchObject({
      baseBranch: 'release',
      baseSource: 'origin_head',
    });
  });

  it('refuses a linked worktree as not the main checkout and suggests the main path', async () => {
    ws = workspace();
    const root = await ws.repo('x', 'git@github.com:acme/x.git');
    await ws.commit('x');
    const worktree = join(ws.ws, '.wt-x-i1');
    await ws.run(root, 'worktree', 'add', '-q', '-b', 'feat/1', worktree);

    const result = await inspect(worktree);

    expect(result).toMatchObject({
      root,
      gitCommonDir: join(root, '.git'),
      isMainCheckout: false,
      remote: { repo: 'acme/x' },
      docs: { kind: 'none', candidates: [] },
    });
    expect(result.warnings).toContain(
      `${worktree} is not the main checkout; connect ${root} instead.`,
    );
  });

  it('refuses a subdirectory of the main checkout the same way', async () => {
    ws = workspace();
    const root = await ws.repo('x', 'git@github.com:acme/x.git');
    ws.files({ 'x/apps/': '' });
    expect(await inspect(join(root, 'apps'))).toMatchObject({
      root,
      isMainCheckout: false,
    });
  });

  it('reports a non-GitHub origin as unsupported', async () => {
    ws = workspace();
    const root = await ws.repo(
      'cockpit',
      'git@gitlab-fwg.example.com:team/cockpit.git',
    );
    const result = await inspect(root);
    expect(result.remote).toEqual({
      url: 'git@gitlab-fwg.example.com:team/cockpit.git',
      forge: 'unsupported',
      repo: null,
    });
    expect(result.warnings.join('\n')).toContain('not on GitHub');
  });

  it('reports a repository with no origin as unsupported', async () => {
    ws = workspace();
    const root = await ws.repo('x');
    expect((await inspect(root)).remote).toEqual({
      url: null,
      forge: 'unsupported',
      repo: null,
    });
  });

  it('reports invalid config JSON instead of failing', async () => {
    ws = workspace();
    const root = await ws.repo('x', 'git@github.com:acme/x.git');
    ws.files({ 'x/.code-analyzer-config.json': '{ "orchestrator": ' });
    const result = await inspect(root);
    expect(result.codeSentinelConfig.orchestrator).toBeUndefined();
    expect(result.codeSentinelConfig.error).toContain('not valid JSON');
    expect(result.baseSource).toBe('default');
  });

  it('answers path_not_found and not_a_repository', async () => {
    ws = workspace();
    ws.files({ 'plain/': '', 'file.txt': '' });
    expect(await failure(inspect(join(ws.ws, 'missing')))).toBe(
      'path_not_found',
    );
    expect(await failure(inspect(join(ws.ws, 'file.txt')))).toBe(
      'path_not_found',
    );
    expect(await failure(inspect(join(ws.ws, 'plain')))).toBe(
      'not_a_repository',
    );
  });
});

describe('project.refresh', () => {
  it('re-inspects a root registered under that project id', async () => {
    ws = workspace();
    const root = await ws.repo('x', 'git@github.com:acme/x.git');
    const result = await refreshProject(
      { projectId: 'prj_x', root },
      [{ id: 'prj_x', root }],
      { exec: gitWithFakeGh(ws.git) },
    );
    expect(result.root).toBe(root);
  });

  it('refuses a root that is not registered, or registered to another project', async () => {
    ws = workspace();
    const root = await ws.repo('x', 'git@github.com:acme/x.git');
    const deps = { exec: gitWithFakeGh(ws.git) };
    expect(
      await failure(refreshProject({ projectId: 'prj_x', root }, [], deps)),
    ).toBe('path_not_allowed');
    expect(
      await failure(
        refreshProject(
          { projectId: 'prj_x', root },
          [{ id: 'prj_y', root }],
          deps,
        ),
      ),
    ).toBe('path_not_allowed');
  });
});
