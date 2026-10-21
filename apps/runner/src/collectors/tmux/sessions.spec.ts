import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FleetProject } from '../../fleet/project';
import { SlotBook } from '../../fleet/slots';
import { QuotaResumer, RESUME_GRACE_MS } from '../../quota/resume';
import { FakeClock } from '../../testing/fake-clock';
import { memoryLogger } from '../../testing/fixtures';
import { SlotSessions } from './sessions';
import type { TmuxPane } from './tmux';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, '__fixtures__', `${name}.txt`), 'utf8');

const PANE: TmuxPane = {
  session: 'cs-i741',
  paneId: '%7',
  active: true,
  path: '/repo/.wt-repo-i741',
  pid: 1,
  startCommand: 'claude',
};
const project: FleetProject = {
  id: 'p',
  root: '/repo',
  github: null,
  repo: 'repo',
  boardDir: '/repo/.git/cs-orchestrator',
  sessionPrefix: null,
  defaultBase: null,
};
const HOUR = 3_600_000;

const setup = () => {
  const clock = new FakeClock(Date.parse('2026-10-21T12:00:00Z'));
  const book = new SlotBook();
  book.worktrees.set('i741', { path: '/repo/.wt-repo-i741' });
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const typed: string[] = [];
  let pane = fixture('quota-5hour');
  const sessions = new SlotSessions({
    project,
    book,
    emit: (type, data) => {
      events.push({ type, data: data as Record<string, unknown> });
    },
    capture: async () => pane,
    now: () => clock.now(),
    resume: {
      resumer: new QuotaResumer(clock, memoryLogger().log),
      type: async (_pane, text) => {
        typed.push(text);
      },
    },
  });
  return {
    clock,
    events,
    typed,
    sessions,
    show: (text: string) => {
      pane = text;
    },
  };
};

describe('SlotSessions quota', () => {
  it('reports the limit with its reset, then resumes once the limit has reset', async () => {
    const { clock, events, typed, sessions } = setup();
    await sessions.poll([PANE]);
    const hit = events.find((e) => e.type === 'pane.quota_hit');
    expect(hit?.data.limit).toBe('session');
    expect(hit?.data.resetsAt).toBe('2026-10-21T15:00:00.000Z');

    clock.advance(3 * HOUR + RESUME_GRACE_MS);
    await Bun.sleep(0);
    expect(typed).toEqual(['continue']);
    expect(events.filter((e) => e.type === 'pane.quota_resumed')).toHaveLength(
      1,
    );

    await sessions.poll([PANE]);
    clock.advance(10 * HOUR);
    await Bun.sleep(0);
    expect(typed).toEqual(['continue']);
  });

  it('types nothing when the session is working again by then', async () => {
    const { clock, events, typed, sessions, show } = setup();
    await sessions.poll([PANE]);
    show(fixture('busy'));
    await sessions.poll([PANE]);
    clock.advance(4 * HOUR);
    await Bun.sleep(0);
    expect(typed).toEqual([]);
    expect(events.some((e) => e.type === 'pane.quota_resumed')).toBe(false);
  });

  it('types nothing when the session has gone', async () => {
    const { clock, typed, sessions } = setup();
    await sessions.poll([PANE]);
    await sessions.poll([]);
    clock.advance(4 * HOUR);
    await Bun.sleep(0);
    expect(typed).toEqual([]);
  });
});
