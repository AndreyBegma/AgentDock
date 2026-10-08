import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  LlmRequestData,
  SessionObservedData,
  UnsequencedEvent,
  WatchedProject,
} from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger, tempDir } from '../testing/fixtures';
import { adapters } from './index';
import { SessionWatcher } from './watcher';

const FIXTURE_PROFILE = join(import.meta.dir, 'claude', 'fixtures', 'profile');
const SESSION = '11111111-1111-4111-8111-111111111111';
const ACME: WatchedProject = { id: 'prj_acme', root: '/srv/dev/acme' };
const OTHER: WatchedProject = { id: 'prj_other', root: '/srv/dev/other' };
const LONG_AGO = new Date('2020-01-01T00:00:00.000Z');

let dir: string;
let cleanup: () => void;
let mainFile: string;
let claude: ConfigProfile;

beforeEach(() => {
  ({ dir, cleanup } = tempDir());
  const profileDir = join(dir, 'claude');
  cpSync(FIXTURE_PROFILE, profileDir, { recursive: true });
  mainFile = join(
    profileDir,
    'projects',
    '-srv-dev--wt-acme-i42',
    `${SESSION}.jsonl`,
  );
  claude = {
    id: 'claude-test',
    runtime: 'claude',
    env: { CLAUDE_CONFIG_DIR: profileDir },
    args: [],
  };
});
afterEach(() => cleanup());

const watcher = (
  options: {
    profiles?: ConfigProfile[];
    ingestSince?: Date;
    events?: UnsequencedEvent[];
  } = {},
) => {
  const events = options.events ?? [];
  const { log } = memoryLogger();
  const instance = new SessionWatcher({
    adapters,
    profiles: options.profiles ?? [claude],
    home: dir,
    offsetsFile: join(dir, 'state', 'offsets.json'),
    ingestSince: options.ingestSince ?? LONG_AGO,
    emit: (event) => events.push(event),
    clock: new FakeClock(),
    log,
    watch: false,
  });
  return { instance, events };
};

const requestIds = (events: UnsequencedEvent[]) =>
  events
    .filter((e) => e.type === 'llm.request')
    .map((e) => (e.data as LlmRequestData).requestId);

const assistantLine = (requestId: string, ts: string) =>
  `${JSON.stringify({
    type: 'assistant',
    requestId,
    sessionId: SESSION,
    cwd: '/srv/dev/.wt-acme-i42',
    timestamp: ts,
    message: {
      id: `msg_${requestId}`,
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'SENTINEL_LATER' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  })}\n`;

describe('SessionWatcher: tailing (D5)', () => {
  it('reads every transcript once, and a second scan sends nothing', async () => {
    const { instance, events } = watcher();
    await instance.start([ACME]);
    expect(requestIds(events).sort()).toEqual([
      'req_A',
      'req_B',
      'req_C',
      'req_D',
      'req_S1',
      'req_S2',
    ]);
    const count = events.length;
    await instance.scan();
    expect(events.length).toBe(count);
    await instance.stop();
  });

  it('sends only the new events when lines are appended', async () => {
    const { instance, events } = watcher();
    await instance.start([ACME]);
    events.length = 0;
    appendFileSync(
      mainFile,
      assistantLine('req_E', '2026-10-01T10:06:00.000Z'),
    );
    await instance.scan();
    expect(events.map((e) => e.type)).toEqual(['llm.request']);
    expect(requestIds(events)).toEqual(['req_E']);
    await instance.stop();
  });

  it('leaves a line still being written for the next read', async () => {
    const { instance, events } = watcher();
    await instance.start([ACME]);
    events.length = 0;
    const line = assistantLine('req_F', '2026-10-01T10:07:00.000Z');
    appendFileSync(mainFile, line.slice(0, 40));
    await instance.scan();
    expect(events).toEqual([]);
    appendFileSync(mainFile, line.slice(40));
    await instance.scan();
    expect(requestIds(events)).toEqual(['req_F']);
    await instance.stop();
  });

  it('does not re-send old events after a restart', async () => {
    const first = watcher();
    await first.instance.start([ACME]);
    await first.instance.stop();
    appendFileSync(
      mainFile,
      assistantLine('req_G', '2026-10-01T10:08:00.000Z'),
    );

    const second = watcher();
    await second.instance.start([ACME]);
    expect(requestIds(second.events)).toEqual(['req_G']);
    expect(second.events.some((e) => e.type === 'session.observed')).toBe(
      false,
    );
    await second.instance.stop();
  });

  it('resumes a tool call opened before the restart and closes it after', async () => {
    const lines = readFileSync(mainFile, 'utf8').split('\n');
    // Up to and including the Bash tool_use, not its result.
    writeFileSync(mainFile, `${lines.slice(0, 5).join('\n')}\n`);
    const first = watcher();
    await first.instance.start([ACME]);
    await first.instance.stop();

    appendFileSync(mainFile, `${lines[5]}\n`);
    const second = watcher();
    await second.instance.start([ACME]);
    expect(second.events.map((e) => [e.type, e.data])).toEqual([
      [
        'tool.call',
        {
          toolUseId: 'toolu_bash1',
          promptId: 'p-1',
          tool: 'Bash',
          startedAt: '2026-10-01T10:00:02.200Z',
          endedAt: '2026-10-01T10:00:05.000Z',
          ok: true,
          durationMs: 2800,
        },
      ],
    ]);
    await second.instance.stop();
  });

  it('reads a transcript anew when it was replaced by a shorter one', async () => {
    const { instance, events } = watcher();
    await instance.start([ACME]);
    events.length = 0;
    writeFileSync(mainFile, assistantLine('req_H', '2026-10-01T10:09:00.000Z'));
    await instance.scan();
    expect(requestIds(events)).toEqual(['req_H']);
    await instance.stop();
  });

  it('drops every field outside the shared schema before emitting (D9)', async () => {
    const { instance, events } = watcher();
    await instance.start([ACME]);
    expect(events.length).toBeGreaterThan(20);
    expect(JSON.stringify(events)).not.toContain('SENTINEL');
    for (const event of events) {
      expect(event).toMatchObject({ v: 1, source: 'transcript' });
    }
    await instance.stop();
  });
});

describe('SessionWatcher: ingestSince and backfill (D11)', () => {
  const age = (date: Date) => {
    for (const path of [
      mainFile,
      join(
        mainFile.replace(/\.jsonl$/, ''),
        'subagents',
        'agent-aaaa1111.jsonl',
      ),
    ]) {
      utimesSync(path, date, date);
    }
  };

  it('does not read transcripts last modified before ingestSince', async () => {
    age(new Date('2026-09-01T00:00:00.000Z'));
    const { instance, events } = watcher({
      ingestSince: new Date('2026-10-01T00:00:00.000Z'),
    });
    await instance.start([ACME]);
    expect(events).toEqual([]);
    await instance.stop();
  });

  it('backfills transcripts modified after since, from their start, then tails them', async () => {
    age(new Date('2026-09-15T00:00:00.000Z'));
    const { instance, events } = watcher({
      ingestSince: new Date('2026-10-01T00:00:00.000Z'),
    });
    await instance.start([ACME]);

    const none = await instance.backfill({
      since: new Date('2026-09-20T00:00:00.000Z'),
    });
    expect(none).toEqual({ files: 0, events: 0 });

    const result = await instance.backfill({
      since: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(result.files).toBe(2);
    expect(result.events).toBe(events.length);
    expect(requestIds(events)).toHaveLength(6);

    events.length = 0;
    appendFileSync(
      mainFile,
      assistantLine('req_I', '2026-10-01T10:10:00.000Z'),
    );
    await instance.scan();
    expect(requestIds(events)).toEqual(['req_I']);
    await instance.stop();
  });

  it('backfills only the sessions of the project asked for', async () => {
    age(new Date('2026-09-15T00:00:00.000Z'));
    const { instance, events } = watcher({
      ingestSince: new Date('2026-10-01T00:00:00.000Z'),
    });
    await instance.start([ACME, OTHER]);
    expect(events).toEqual([]);

    const other = await instance.backfill({
      projectId: 'prj_other',
      since: LONG_AGO,
    });
    expect(other).toEqual({ files: 0, events: 0 });
    expect(events).toEqual([]);

    const acme = await instance.backfill({
      projectId: 'prj_acme',
      since: LONG_AGO,
    });
    expect(acme.files).toBe(2);
    expect(requestIds(events)).toHaveLength(6);
    await instance.stop();
  });
});

describe('SessionWatcher: correlation follows the watch list (D6)', () => {
  it('re-sends session.observed when a session gains a project', async () => {
    const { instance, events } = watcher();
    await instance.start([]);
    const before = events
      .filter((e) => e.type === 'session.observed')
      .map((e) => e.data as SessionObservedData);
    expect(before.every((o) => o.projectId === undefined)).toBe(true);

    events.length = 0;
    await instance.setProjects([ACME]);
    expect(events.map((e) => [e.type, e.session?.id])).toEqual(
      expect.arrayContaining([
        ['session.observed', SESSION],
        ['session.observed', 'aaaa1111'],
      ]),
    );
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.data).toMatchObject({ projectId: 'prj_acme', slot: 'i42' });
    }

    events.length = 0;
    await instance.setProjects([ACME]);
    expect(events).toEqual([]);
    await instance.stop();
  });
});

describe('SessionWatcher: codex (D7)', () => {
  it('reports each codex transcript once, as not parsed', async () => {
    const codexHome = join(dir, 'codex');
    const day = join(codexHome, 'sessions', '2026', '10', '01');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-1.jsonl'), '{"SENTINEL_CODEX":1}\n');
    const codex: ConfigProfile = {
      id: 'codex-test',
      runtime: 'codex',
      env: { CODEX_HOME: codexHome },
      args: [],
    };
    const { instance, events } = watcher({ profiles: [codex] });
    await instance.start([ACME]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'session.observed',
      session: { runtime: 'codex', id: 'rollout-1' },
      data: { parsed: false, cwd: day, profileKey: 'codex-test' },
    });
    expect((events[0].data as SessionObservedData).projectId).toBeUndefined();

    appendFileSync(join(day, 'rollout-1.jsonl'), '{"more":1}\n');
    await instance.scan();
    expect(events).toHaveLength(1);
    await instance.stop();
  });
});
