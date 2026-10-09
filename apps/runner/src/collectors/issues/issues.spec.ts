import { describe, expect, it } from 'bun:test';
import {
  issueClosedDataSchema,
  issuesSnapshotDataSchema,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import type { Exec, ExecResult } from '../../detect/exec';
import { FakeClock } from '../../testing/fake-clock';
import { memoryLogger } from '../../testing/fixtures';
import { DEFAULT_FLEET_SETTINGS } from '../registry';
import { IssuesCollector } from './issues';
import { GH_API_TIMEOUT_MS } from './listing';
import { IssuesRefreshers } from './refresh';

const PROJECT = { id: 'prj_1', root: '/srv/widget' };
const ISSUES_1 =
  'api -i repos/acme/widget/issues?state=open&per_page=100&page=1';
const ISSUES_1_ETAG = `api -i -H If-None-Match: "v1" repos/acme/widget/issues?state=open&per_page=100&page=1`;
const ISSUES_2 = 'api repos/acme/widget/issues?state=open&per_page=100&page=2';
const timeline = (n: number) =>
  `api repos/acme/widget/issues/${n}/timeline?per_page=100&page=1`;

const item = (number: number, body = '', extra: object = {}) => ({
  number,
  title: `Issue ${number}`,
  body,
  html_url: `https://github.com/acme/widget/issues/${number}`,
  updated_at: '2026-10-08T09:00:00Z',
  labels: [{ name: 'cs:ready' }],
  assignees: [],
  ...extra,
});

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const page = (items: object[], etag = '"v1"'): ExecResult =>
  ok(`HTTP/2.0 200 OK\r\nEtag: ${etag}\r\n\r\n${JSON.stringify(items)}`);
const notModified: ExecResult = {
  code: 1,
  stdout: 'HTTP/2.0 304 Not Modified\r\nEtag: "v1"\r\n\r\n',
  stderr: 'gh: HTTP 304',
};

const setup = (pollSeconds?: number) => {
  const gh: Record<string, ExecResult | null> = {};
  const calls: string[] = [];
  const events: UnsequencedEvent[] = [];
  const timeouts: (number | undefined)[] = [];
  const exec: Exec = async (binary, args, options) => {
    const key = args.join(' ');
    if (binary === 'git') {
      return key === '-C /srv/widget remote get-url origin'
        ? ok('git@github.com:acme/widget.git\n')
        : { code: 1, stdout: '', stderr: '' };
    }
    calls.push(key);
    timeouts.push(options?.timeoutMs);
    return gh[key] ?? null;
  };
  const clock = new FakeClock();
  const { log, lines } = memoryLogger();
  const refreshers = new IssuesRefreshers();
  const collector = new IssuesCollector(
    { exec, clock, log, fleet: DEFAULT_FLEET_SETTINGS },
    { pollSeconds, refreshers },
  );
  const start = async () => {
    await collector.start(PROJECT, (e) => events.push(e));
    await collector.settled();
  };
  const ofType = (type: string) => events.filter((e) => e.type === type);
  return {
    gh,
    calls,
    timeouts,
    events,
    ofType,
    collector,
    clock,
    refreshers,
    start,
    lines,
  };
};

describe('IssuesCollector', () => {
  it('emits a snapshot, splitting issues from pull requests', async () => {
    const t = setup();
    t.gh[ISSUES_1] = page([
      item(1, null as unknown as string, { labels: ['bug', { name: 'x' }] }),
      item(2, 'Closes #1', { pull_request: { url: 'u' } }),
    ]);
    await t.start();
    expect(t.events).toHaveLength(1);
    const [event] = t.events;
    expect(event).toMatchObject({
      type: 'issues.snapshot',
      source: 'runner',
      project: { repo: 'acme/widget', root: '/srv/widget' },
    });
    const data = issuesSnapshotDataSchema.parse(event.data);
    expect(data.open).toEqual([1, 2]);
    expect(data.issues).toMatchObject([
      { number: 1, body: '', labels: ['bug', 'x'] },
    ]);
    expect(data.pullRequests).toMatchObject([{ number: 2, body: 'Closes #1' }]);
  });

  it('gives every gh call a network-sized timeout', async () => {
    const t = setup();
    t.gh[ISSUES_1] = page(Array.from({ length: 100 }, (_, i) => item(i + 1)));
    t.gh[ISSUES_2] = ok(JSON.stringify([item(101, 'Depends on #900')]));
    await t.start();
    expect(t.timeouts).toHaveLength(3);
    expect(t.timeouts.every((ms) => ms === GH_API_TIMEOUT_MS)).toBe(true);
    expect(GH_API_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it('sends If-None-Match and emits nothing on a 304', async () => {
    const t = setup();
    t.gh[ISSUES_1] = page([item(1)]);
    t.gh[ISSUES_1_ETAG] = notModified;
    await t.start();
    await t.collector.tick();
    expect(t.calls).toEqual([
      'api -i repos/acme/widget/issues?state=open&per_page=100&page=1',
      'api -i -H If-None-Match: "v1" repos/acme/widget/issues?state=open&per_page=100&page=1',
    ]);
    expect(t.ofType('issues.snapshot')).toHaveLength(1);
    expect(t.ofType('issues.unavailable')).toHaveLength(0);
  });

  it('polls on the interval', async () => {
    const t = setup(60);
    t.gh[ISSUES_1] = page([item(1)]);
    t.gh[ISSUES_1_ETAG] = notModified;
    await t.start();
    t.clock.advance(60_000);
    await t.collector.tick();
    expect(t.calls.length).toBeGreaterThanOrEqual(2);
    t.collector.stop();
  });

  it('polls every 60 s by default and at the context interval when set', async () => {
    const stopped = async (fleet: typeof DEFAULT_FLEET_SETTINGS) => {
      const clock = new FakeClock();
      const collector = new IssuesCollector(
        {
          exec: async () => ({ code: 1, stdout: '', stderr: '' }),
          clock,
          log: memoryLogger().log,
          fleet,
        },
        { refreshers: new IssuesRefreshers() },
      );
      await collector.start(PROJECT, () => {});
      const delays = clock.pending();
      collector.stop();
      return delays;
    };
    expect(await stopped(DEFAULT_FLEET_SETTINGS)).toContain(60_000);
    expect(
      await stopped({ ...DEFAULT_FLEET_SETTINGS, queuePollSeconds: 120 }),
    ).toContain(120_000);
  });

  it('reads further pages only when the first changed', async () => {
    const t = setup();
    const full = Array.from({ length: 100 }, (_, i) => item(i + 1));
    t.gh[ISSUES_1] = page(full);
    t.gh[ISSUES_2] = ok(JSON.stringify([item(101), item(102)]));
    await t.start();
    const data = issuesSnapshotDataSchema.parse(t.events[0].data);
    expect(data.open).toHaveLength(102);
    expect(t.calls).toEqual([
      'api -i repos/acme/widget/issues?state=open&per_page=100&page=1',
      ISSUES_2,
    ]);
    t.gh[ISSUES_1_ETAG] = notModified;
    await t.collector.tick();
    expect(t.calls).toHaveLength(3);
  });

  it('reports unavailable once, then recovers with an unconditional read', async () => {
    const t = setup();
    t.gh[ISSUES_1] = {
      code: 1,
      stdout: '',
      stderr: 'gh: To get started with GitHub CLI, please run: gh auth login',
    };
    await t.start();
    await t.collector.tick();
    expect(t.ofType('issues.unavailable')).toHaveLength(1);
    expect(t.events[0].data).toEqual({
      reason: expect.stringContaining('gh auth login'),
    });

    t.gh[ISSUES_1] = page([item(1)]);
    await t.collector.tick();
    expect(t.ofType('issues.snapshot')).toHaveLength(1);
    // After an outage a 304 would leave the API showing "unavailable".
    t.gh[ISSUES_1_ETAG] = notModified;
    await t.collector.tick();
    expect(t.ofType('issues.snapshot')).toHaveLength(1);
  });

  it('is unavailable when gh is not installed', async () => {
    const t = setup();
    await t.start();
    expect(t.events).toMatchObject([
      { type: 'issues.unavailable', data: { reason: expect.any(String) } },
    ]);
  });

  describe('issue.closed', () => {
    const closedEvents = (extra: object[]) => [
      { event: 'labeled' },
      { event: 'closed', created_at: '2026-10-08T08:00:00Z', ...extra[0] },
      ...extra.slice(1),
    ];

    it('reports a dependency closed by a merged pull request, once', async () => {
      const t = setup();
      t.gh[ISSUES_1] = page([item(5, 'Depends on #3\nDepends on #4')]);
      t.gh[timeline(3)] = ok(
        JSON.stringify(
          closedEvents([
            { commit_id: 'abc' },
            {
              event: 'cross-referenced',
              source: {
                issue: {
                  number: 9,
                  pull_request: { merged_at: '2026-10-08T08:00:00Z' },
                },
              },
            },
          ]),
        ),
      );
      t.gh[timeline(4)] = ok(
        JSON.stringify(closedEvents([{ commit_id: null }])),
      );
      await t.start();
      const closed = t
        .ofType('issue.closed')
        .map((e) => issueClosedDataSchema.parse(e.data));
      expect(closed).toEqual([
        {
          number: 3,
          closedBy: 'pr',
          pr: 9,
          closedAt: '2026-10-08T08:00:00Z',
        },
        { number: 4, closedBy: 'manual', closedAt: '2026-10-08T08:00:00Z' },
      ]);
      // A changed listing again does not report them twice.
      t.gh[ISSUES_1_ETAG] = page(
        [item(5, 'Depends on #3\nDepends on #4')],
        '"v2"',
      );
      await t.collector.tick();
      expect(t.ofType('issue.closed')).toHaveLength(2);
    });

    it('does not look up an open dependency, and retries an unreadable timeline', async () => {
      const t = setup();
      t.gh[ISSUES_1] = page([item(5, 'Depends on #3\nDepends on #6'), item(6)]);
      await t.start();
      expect(t.calls.filter((c) => c.includes('timeline'))).toEqual([
        timeline(3),
      ]);
      expect(t.ofType('issue.closed')).toHaveLength(0);

      t.gh[ISSUES_1_ETAG] = notModified;
      t.gh[timeline(3)] = ok(
        JSON.stringify(closedEvents([{ commit_id: null }])),
      );
      await t.collector.tick();
      expect(t.ofType('issue.closed')).toHaveLength(1);
    });
  });

  describe('issues.refresh', () => {
    it('polls now and ignores the ETag', async () => {
      const t = setup();
      t.gh[ISSUES_1] = page([item(1)]);
      await t.start();
      expect(t.refreshers.get(PROJECT.id)).toBeDefined();
      t.gh[ISSUES_1_ETAG] = notModified;
      const result = await t.refreshers.get(PROJECT.id)?.();
      expect(result).toEqual({
        changed: true,
        fetchedAt: expect.any(String),
      });
      expect(t.ofType('issues.snapshot')).toHaveLength(2);
      expect(t.calls.at(-1)).toBe(ISSUES_1);
    });

    it('fails with the gh error when the listing cannot be read', async () => {
      const t = setup();
      await t.start();
      await expect(t.collector.refresh()).rejects.toThrow(
        'gh is not available',
      );
    });

    it('is gone once the collector stops', async () => {
      const t = setup();
      await t.start();
      t.collector.stop();
      expect(t.refreshers.get(PROJECT.id)).toBeUndefined();
    });
  });
});
