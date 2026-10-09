import { describe, expect, it } from 'bun:test';
import type { ExecResult } from '../../detect/exec';
import { brief, fleetFixture } from '../../fleet/testing';
import { memoryLogger } from '../../testing/fixtures';
import { PrWatcher, parsePrList } from './prs';

const LIST =
  'pr list --repo acme/widget --state open --limit 100 --json number,headRefName,headRefOid,statusCheckRollup,mergeable,title,url';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);

const pr = (
  number: number,
  branch: string,
  checks: object[],
  mergeable = 'MERGEABLE',
  headRefOid?: unknown,
) => ({
  number,
  headRefName: branch,
  title: `PR ${number}`,
  url: `https://github.com/acme/widget/pull/${number}`,
  mergeable,
  statusCheckRollup: checks,
  ...(headRefOid === undefined ? {} : { headRefOid }),
});

const run = (conclusion: string | null, status = 'COMPLETED') => ({
  status,
  conclusion,
});

const setup = () => {
  const f = fleetFixture();
  f.book.worktrees.set('i42', {
    path: '/srv/.wt-widget-i42',
    branch: 'feat/42-x',
  });
  const gh: Record<string, ExecResult | null> = {};
  const calls: string[] = [];
  const { log, lines } = memoryLogger();
  const watcher = new PrWatcher({
    ...f,
    log,
    exec: async (binary, args) => {
      calls.push(`${binary} ${args.join(' ')}`);
      return binary === 'gh' ? (gh[args.join(' ')] ?? null) : null;
    },
  });
  const list = (prs: object[]) => {
    gh[LIST] = { code: 0, stdout: JSON.stringify(prs), stderr: '' };
  };
  return { ...f, watcher, gh, list, calls, lines };
};

describe('PrWatcher', () => {
  it('flips checks from pending to green, and to red on one failure', async () => {
    const { watcher, events, list } = setup();
    list([pr(7, 'feat/42-x', [run('SUCCESS'), run(null, 'IN_PROGRESS')])]);
    await watcher.poll();
    await watcher.poll();
    list([pr(7, 'feat/42-x', [run('SUCCESS'), run('SKIPPED')])]);
    await watcher.poll();
    list([pr(7, 'feat/42-x', [run('SUCCESS'), run('FAILURE')])]);
    await watcher.poll();
    expect(brief(events.take())).toEqual([
      {
        type: 'pr.opened',
        slot: 'i42',
        data: {
          number: 7,
          branch: 'feat/42-x',
          url: 'https://github.com/acme/widget/pull/7',
          title: 'PR 7',
          checks: 'pending',
          mergeable: true,
        },
      },
      {
        type: 'pr.checks_changed',
        slot: 'i42',
        data: {
          number: 7,
          branch: 'feat/42-x',
          checks: 'green',
          mergeable: true,
        },
      },
      {
        type: 'pr.checks_changed',
        slot: 'i42',
        data: {
          number: 7,
          branch: 'feat/42-x',
          checks: 'red',
          mergeable: true,
        },
      },
    ]);
  });

  it('reports a change of mergeability, and leaves unknown out', async () => {
    const { watcher, events, list } = setup();
    list([pr(7, 'feat/42-x', [], 'UNKNOWN')]);
    await watcher.poll();
    list([pr(7, 'feat/42-x', [], 'CONFLICTING')]);
    await watcher.poll();
    const [opened, changed] = events.take();
    expect(opened.data).not.toHaveProperty('mergeable');
    expect(changed.data).toMatchObject({ checks: 'green', mergeable: false });
  });

  it('carries the head as headSha, and reports a push alone as pr.checks_changed', async () => {
    const { watcher, events, list } = setup();
    list([pr(7, 'feat/42-x', [], 'MERGEABLE', H1)]);
    await watcher.poll();
    await watcher.poll();
    list([pr(7, 'feat/42-x', [], 'MERGEABLE', H2)]);
    await watcher.poll();
    expect(brief(events.take())).toEqual([
      {
        type: 'pr.opened',
        slot: 'i42',
        data: {
          number: 7,
          branch: 'feat/42-x',
          url: 'https://github.com/acme/widget/pull/7',
          title: 'PR 7',
          checks: 'green',
          mergeable: true,
          headSha: H1,
        },
      },
      {
        type: 'pr.checks_changed',
        slot: 'i42',
        data: {
          number: 7,
          branch: 'feat/42-x',
          checks: 'green',
          mergeable: true,
          headSha: H2,
        },
      },
    ]);
  });

  it('leaves headSha out when gh sends no head or a malformed one, and still follows the PR', async () => {
    const { watcher, events, list } = setup();
    list([pr(7, 'feat/42-x', [], 'MERGEABLE', 'not-a-sha')]);
    await watcher.poll();
    list([pr(7, 'feat/42-x', [], 'CONFLICTING')]);
    await watcher.poll();
    const [opened, changed] = events.take();
    expect(opened.data).not.toHaveProperty('headSha');
    expect(changed.data).not.toHaveProperty('headSha');
    expect(changed.data).toMatchObject({ mergeable: false });
  });

  it('follows only branches of known slots', async () => {
    const { watcher, events, list } = setup();
    list([pr(8, 'chore/deps', [])]);
    await watcher.poll();
    expect(events.take()).toEqual([]);
  });

  it('reports a PR that left the list as merged or closed', async () => {
    const { watcher, events, list, gh } = setup();
    list([pr(7, 'feat/42-x', [])]);
    await watcher.poll();
    events.take();
    list([]);
    await watcher.poll();
    expect(events.take()).toEqual([]);
    gh['pr view 7 --repo acme/widget --json state'] = {
      code: 0,
      stdout: '{"state":"MERGED"}',
      stderr: '',
    };
    await watcher.poll();
    await watcher.poll();
    expect(brief(events.take())).toEqual([
      {
        type: 'pr.closed',
        slot: 'i42',
        data: { number: 7, branch: 'feat/42-x', merged: true },
      },
    ]);
  });

  it('degrades without gh or a GitHub remote, logs once, and recovers', async () => {
    const { watcher, events, list, lines } = setup();
    await watcher.poll();
    await watcher.poll();
    expect(
      lines.filter((l) => l.includes('pull requests unavailable')),
    ).toHaveLength(1);
    list([pr(7, 'feat/42-x', [])]);
    await watcher.poll();
    expect(events.take().map((e) => e.type)).toEqual(['pr.opened']);
    expect(lines.join('\n')).toContain('pull requests available again');

    const local = fleetFixture({ github: null });
    const calls: string[] = [];
    await new PrWatcher({
      ...local,
      log: memoryLogger().log,
      exec: async (binary) => {
        calls.push(binary);
        return null;
      },
    }).poll();
    expect(calls).toEqual([]);
  });
});

describe('parsePrList', () => {
  it('drops entries that do not fit and refuses what is not a JSON array', () => {
    expect(
      parsePrList(JSON.stringify([pr(7, 'a', []), { number: 'x' }]))?.map(
        (p) => p.number,
      ),
    ).toEqual([7]);
    expect(
      parsePrList(JSON.stringify([pr(7, 'a', [], 'MERGEABLE', 42)]))?.[0]
        ?.headRefOid,
    ).toBeUndefined();
    expect(parsePrList('{}')).toBeNull();
    expect(parsePrList('not json')).toBeNull();
  });
});
