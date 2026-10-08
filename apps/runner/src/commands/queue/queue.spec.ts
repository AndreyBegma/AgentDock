import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { issueCreateArgsSchema } from '@agentdock/shared/protocol';
import { IssuesRefreshers } from '../../collectors/issues/refresh';
import type { Exec, ExecResult } from '../../detect/exec';
import { tempDir } from '../../testing/fixtures';
import { CommandFailure } from '../failure';
import { issueCreate, parseCreated } from './issue-create';
import { issuesRefresh } from './issues-refresh';

const AC = '## Acceptance criteria\n- [ ] it works\n';
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

describe('issue.create', () => {
  let root: string;
  let temp: string;
  beforeEach(() => {
    root = tempDir().dir;
    temp = tempDir().dir;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  });

  const setup = (
    create: ExecResult | null = ok(
      'https://github.com/acme/widget/issues/14\n',
    ),
  ) => {
    const calls: { binary: string; args: string[]; body?: string }[] = [];
    const exec: Exec = async (binary, args) => {
      const list = [...args];
      if (binary === 'git') {
        return list.join(' ') === `-C ${root} remote get-url origin`
          ? ok('git@github.com:acme/widget.git\n')
          : { code: 1, stdout: '', stderr: '' };
      }
      const file = list[list.indexOf('--body-file') + 1];
      calls.push({
        binary,
        args: list,
        body: file ? readFileSync(file, 'utf8') : undefined,
      });
      return create;
    };
    const run = (args: Partial<Parameters<typeof issueCreate>[0]> = {}) =>
      issueCreate(
        issueCreateArgsSchema.parse({
          projectId: 'prj_1',
          title: 'A title',
          body: AC,
          labels: ['enhancement'],
          queue: false,
          ...args,
        }),
        {
          exec,
          watchedProjects: () => [{ id: 'prj_1', root }],
          tempRoot: temp,
        },
      );
    return { calls, run };
  };

  it('creates the issue with the body in a file and one --label per label', async () => {
    const { calls, run } = setup();
    const result = await run({ body: 'a body; $(rm -rf /)', title: '--web' });
    expect(result).toEqual({
      number: 14,
      url: 'https://github.com/acme/widget/issues/14',
      queued: false,
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.binary).toBe('gh');
    expect(call.args.slice(0, 3)).toEqual(['issue', 'create', '--repo']);
    expect(call.args).toContain('acme/widget');
    expect(call.args).toEqual(
      expect.arrayContaining(['--title', '--web', '--label', 'enhancement']),
    );
    expect(call.args.join(' ')).not.toContain('rm -rf');
    expect(call.body).toBe('a body; $(rm -rf /)');
    expect(readdirSync(temp)).toEqual([]);
  });

  it('adds the ready label when queued and the body is complete', async () => {
    const { calls, run } = setup();
    const result = await run({ queue: true });
    expect(result.queued).toBe(true);
    expect(calls[0].args).toEqual(
      expect.arrayContaining(['--label', 'cs:ready']),
    );
  });

  it('uses the ready label from the project config', async () => {
    writeFileSync(
      join(root, '.code-analyzer-config.json'),
      JSON.stringify({ orchestrator: { readyLabel: 'agent:ready' } }),
    );
    const { calls, run } = setup();
    await run({ queue: true });
    expect(calls[0].args).toEqual(
      expect.arrayContaining(['--label', 'agent:ready']),
    );
    expect(calls[0].args).not.toContain('cs:ready');
  });

  it('creates it unlabelled when queued with an incomplete body', async () => {
    const { calls, run } = setup();
    const result = await run({ queue: true, body: 'Just an idea.' });
    expect(result).toMatchObject({
      queued: false,
      reason: 'no_acceptance_criteria',
    });
    expect(calls[0].args).not.toContain('cs:ready');
  });

  it('asks for a parallel plan on an XL issue', async () => {
    const { calls, run } = setup();
    const result = await run({ queue: true, labels: ['size: XL'] });
    expect(result).toMatchObject({ queued: false, reason: 'no_parallel_plan' });
    expect(calls[0].args).not.toContain('cs:ready');
  });

  it('never lets the caller set the ready label without queue', async () => {
    const { calls, run } = setup();
    await run({ labels: ['CS:Ready', 'bug'], queue: false });
    expect(calls[0].args).not.toContain('CS:Ready');
    expect(calls[0].args).toContain('bug');
  });

  it('fails when gh fails, and cleans up the body file', async () => {
    const { run } = setup({
      code: 1,
      stdout: '',
      stderr: 'gh: not logged in\n',
    });
    await expect(run()).rejects.toThrow('not logged in');
    expect(readdirSync(temp)).toEqual([]);
  });

  it('refuses a project the runner does not watch', async () => {
    const { run } = setup();
    mkdirSync(root, { recursive: true });
    await expect(run({ projectId: 'prj_other' })).rejects.toBeInstanceOf(
      CommandFailure,
    );
  });
});

describe('parseCreated', () => {
  it('reads the number from the URL gh prints', () => {
    expect(
      parseCreated(
        'Creating issue in acme/widget\n\nhttps://github.com/acme/widget/issues/7\n',
      ),
    ).toEqual({ number: 7, url: 'https://github.com/acme/widget/issues/7' });
    expect(parseCreated('nothing')).toBeNull();
  });
});

describe('issues.refresh', () => {
  const watched = () => [{ id: 'prj_1', root: '/srv/widget' }];

  it('forwards to the collector of the project', async () => {
    const refreshers = new IssuesRefreshers();
    refreshers.register('prj_1', async () => ({
      changed: true,
      fetchedAt: '2026-10-08T10:00:00.000Z',
    }));
    expect(
      await issuesRefresh(
        { projectId: 'prj_1' },
        { watchedProjects: watched, refreshers },
      ),
    ).toEqual({ changed: true, fetchedAt: '2026-10-08T10:00:00.000Z' });
  });

  it('refuses a project that is not watched or has no collector', async () => {
    const refreshers = new IssuesRefreshers();
    await expect(
      issuesRefresh(
        { projectId: 'prj_2' },
        { watchedProjects: watched, refreshers },
      ),
    ).rejects.toBeInstanceOf(CommandFailure);
    await expect(
      issuesRefresh(
        { projectId: 'prj_1' },
        { watchedProjects: watched, refreshers },
      ),
    ).rejects.toBeInstanceOf(CommandFailure);
  });
});
