import { describe, expect, it } from 'bun:test';
import { boundedName, boundedText, TEXT_NAME_MAX } from './bounded';
import { approvalCommands } from './commands/approvals';
import { collectorPollResultSchema } from './commands/github';
import { eventSchema } from './envelope';
import { fleetEventDataSchemas } from './events/fleet';
import { hookSessionStartedDataSchema } from './events/hooks';
import { issuesSnapshotDataSchema } from './events/queue';
import { heartbeatMessageSchema, helloMessageSchema } from './messages';
import { pairingRequestSchema } from './pairing';

const ts = '2026-10-17T10:00:00.000Z';
const at = (max: number) => 'a'.repeat(max);
const over = (max: number) => 'a'.repeat(max + 1);

/** Asserts `build(value)` parses at `max` characters and fails at `max + 1`. */
const bounds = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  build: (value: string) => unknown,
  max: number,
) => {
  expect(schema.safeParse(build(at(max))).success).toBe(true);
  expect(schema.safeParse(build(over(max))).success).toBe(false);
};

describe('boundedText / boundedName', () => {
  it('bounds the length, and the name also refuses empty', () => {
    expect(boundedText(3).safeParse('abc').success).toBe(true);
    expect(boundedText(3).safeParse('abcd').success).toBe(false);
    expect(boundedText(3).safeParse('').success).toBe(true);
    expect(boundedName(3).safeParse('').success).toBe(false);
  });
});

describe('envelope', () => {
  const event = (extra: Record<string, unknown>) => ({
    v: 1,
    seq: 1,
    ts,
    type: 'pane.idle',
    source: 'runner',
    data: {},
    ...extra,
  });

  it('holds the slot to slotNameSchema', () => {
    bounds(eventSchema, (v) => event({ slot: v }), 64);
    expect(eventSchema.safeParse(event({ slot: 'A/b' })).success).toBe(false);
    expect(eventSchema.safeParse(event({ slot: '-x' })).success).toBe(false);
    expect(eventSchema.safeParse(event({ slot: 'i42-api' })).success).toBe(
      true,
    );
  });

  it('bounds type, project and session', () => {
    bounds(eventSchema, (v) => event({ type: v }), TEXT_NAME_MAX);
    bounds(
      eventSchema,
      (v) => event({ project: { repo: v, root: '/r' } }),
      TEXT_NAME_MAX,
    );
    bounds(
      eventSchema,
      (v) => event({ project: { repo: 'r', root: v } }),
      4096,
    );
    bounds(
      eventSchema,
      (v) => event({ session: { runtime: 'claude', id: v } }),
      TEXT_NAME_MAX,
    );
  });
});

describe('hello and heartbeat', () => {
  const hello = (extra: Record<string, unknown>) => ({
    type: 'hello',
    runnerVersion: '1.0.0',
    protocolVersion: 1,
    hostname: 'host',
    os: 'linux',
    arch: 'x64',
    capabilities: {
      tmux: null,
      git: null,
      gh: null,
      runtimes: { claude: null, codex: null },
      profiles: [],
      codeSentinel: null,
      otlp: null,
    },
    lastAckedSeq: 0,
    ...extra,
  });
  const heartbeat = (extra: Record<string, unknown>) => ({
    type: 'heartbeat',
    ts,
    load: [0, 0, 0],
    tmuxSessions: 0,
    collectors: {},
    ...extra,
  });

  it('bounds the hello strings', () => {
    for (const field of ['runnerVersion', 'hostname', 'os', 'arch']) {
      bounds(helloMessageSchema, (v) => hello({ [field]: v }), TEXT_NAME_MAX);
    }
  });

  it('bounds the capabilities of a hello', () => {
    const caps = (extra: Record<string, unknown>) =>
      hello({
        capabilities: { ...hello({}).capabilities, ...extra },
      });
    bounds(helloMessageSchema, (v) => caps({ tmux: v }), TEXT_NAME_MAX);
    expect(
      helloMessageSchema.safeParse(
        caps({ profiles: Array.from({ length: 257 }, () => ({})) }),
      ).success,
    ).toBe(false);
  });

  it('bounds a collector name and error, and the collector count', () => {
    bounds(
      heartbeatMessageSchema,
      (v) => heartbeat({ collectors: { [v]: { ok: true } } }),
      TEXT_NAME_MAX,
    );
    bounds(
      heartbeatMessageSchema,
      (v) => heartbeat({ collectors: { c: { ok: false, error: v } } }),
      1000,
    );
    const many = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`c${i}`, { ok: true }]),
      );
    expect(
      heartbeatMessageSchema.safeParse(heartbeat({ collectors: many(256) }))
        .success,
    ).toBe(true);
    expect(
      heartbeatMessageSchema.safeParse(heartbeat({ collectors: many(257) }))
        .success,
    ).toBe(false);
  });
});

describe('pairing', () => {
  it('bounds hostname and version', () => {
    const request = (extra: Record<string, unknown>) => ({
      code: 'ABCD-EFGH',
      hostname: 'h',
      version: '1',
      protocolVersion: 1,
      ...extra,
    });
    bounds(
      pairingRequestSchema,
      (v) => request({ hostname: v }),
      TEXT_NAME_MAX,
    );
    bounds(pairingRequestSchema, (v) => request({ version: v }), TEXT_NAME_MAX);
  });
});

describe('fleet events', () => {
  it('bounds the checkpoint heading and summary', () => {
    const schema = fleetEventDataSchemas['slot.checkpoint'];
    bounds(schema, (v) => ({ checkpoint: 'other', heading: v }), 500);
    bounds(schema, (v) => ({ checkpoint: 'other', summary: v }), 4096);
  });

  it('bounds the dispatch brief', () => {
    const schema = fleetEventDataSchemas['slot.dispatched'];
    bounds(schema, (v) => ({ branch: v }), 500);
    bounds(schema, (v) => ({ briefPath: v }), 4096);
    bounds(schema, (v) => ({ owns: [v] }), 500);
    expect(schema.safeParse({ owns: Array(256).fill('a') }).success).toBe(true);
    expect(schema.safeParse({ owns: Array(257).fill('a') }).success).toBe(
      false,
    );
  });

  it('bounds a pull request title and branch', () => {
    const schema = fleetEventDataSchemas['pr.opened'];
    const data = (extra: Record<string, unknown>) => ({
      number: 1,
      branch: 'b',
      url: 'https://github.com/a/b/pull/1',
      title: 't',
      checks: 'green',
      ...extra,
    });
    bounds(schema, (v) => data({ title: v }), 500);
    bounds(schema, (v) => data({ branch: v }), 500);
  });

  it('bounds the state.json snapshot', () => {
    const schema = fleetEventDataSchemas['orchestrator.snapshot'];
    bounds(schema, (v) => ({ state: { v: 1, repo: v } }), TEXT_NAME_MAX);
    bounds(
      schema,
      (v) => ({ state: { v: 1, slots: { s: { model: v } } } }),
      TEXT_NAME_MAX,
    );
    expect(
      schema.safeParse({ state: { v: 1, personNeeded: Array(257).fill(1) } })
        .success,
    ).toBe(false);
  });

  it('bounds a board row', () => {
    const schema = fleetEventDataSchemas['round.decided'];
    bounds(
      schema,
      (v) => ({ decisions: { dispatching: [{ slot: v }] } }),
      4096,
    );
    expect(
      schema.safeParse({
        decisions: { dispatching: Array(257).fill({}) },
      }).success,
    ).toBe(false);
  });

  it('bounds a slot message and an unparsed line reason', () => {
    bounds(
      fleetEventDataSchemas['slot.message_seen'],
      (v) => ({
        body: v,
        mode: 'replaced',
        fileHash: 'a'.repeat(64),
      }),
      16 * 1024,
    );
    bounds(
      fleetEventDataSchemas['board.unparsed'],
      (v) => ({ file: '/f', reason: v }),
      500,
    );
  });
});

describe('queue events', () => {
  const issue = (extra: Record<string, unknown>) => ({
    number: 1,
    title: 't',
    updatedAt: ts,
    url: 'https://github.com/a/b/issues/1',
    ...extra,
  });
  const snapshot = (extra: Record<string, unknown>) => ({
    snapshotId: 's',
    fetchedAt: ts,
    part: 0,
    parts: 1,
    open: [1],
    ...extra,
  });

  it('bounds an issue', () => {
    const schema = issuesSnapshotDataSchema;
    bounds(schema, (v) => snapshot({ issues: [issue({ title: v })] }), 1000);
    bounds(
      schema,
      (v) => snapshot({ issues: [issue({ labels: [v] })] }),
      TEXT_NAME_MAX,
    );
    bounds(
      schema,
      (v) => snapshot({ issues: [issue({ assignees: [v] })] }),
      TEXT_NAME_MAX,
    );
    bounds(
      schema,
      (v) => snapshot({ issues: [issue({ body: v })] }),
      64 * 1024,
    );
    expect(
      schema.safeParse(
        snapshot({ issues: [issue({ labels: Array(101).fill('l') })] }),
      ).success,
    ).toBe(false);
  });

  it('bounds a pull request body and the list sizes', () => {
    const schema = issuesSnapshotDataSchema;
    const pr = (body: string) => ({
      number: 2,
      title: 't',
      body,
      updatedAt: ts,
      url: 'https://github.com/a/b/pull/2',
    });
    bounds(schema, (v) => snapshot({ pullRequests: [pr(v)] }), 16 * 1024);
    expect(
      schema.safeParse(snapshot({ open: Array(50_001).fill(1) })).success,
    ).toBe(false);
    expect(
      schema.safeParse(snapshot({ issues: Array(5_001).fill(issue({})) }))
        .success,
    ).toBe(false);
  });
});

describe('hook events', () => {
  const started = (gitBranch: string) => ({
    source: 'startup',
    cwd: '/work',
    gitBranch,
    permissionMode: 'default',
  });

  it('bounds gitBranch and restricts its charset', () => {
    bounds(hookSessionStartedDataSchema, started, 255);
    for (const branch of ['feat/42-widget', 'release/1.2+hotfix', 'user@x']) {
      expect(
        hookSessionStartedDataSchema.safeParse(started(branch)).success,
      ).toBe(true);
    }
    for (const branch of ['a b', 'a\nb', 'a;rm', '$(x)', '`x`']) {
      expect(
        hookSessionStartedDataSchema.safeParse(started(branch)).success,
      ).toBe(false);
    }
  });
});

describe('approval commands', () => {
  const inspection = (extra: Record<string, unknown>) => ({
    number: 1,
    url: 'https://github.com/a/b/pull/1',
    title: 't',
    body: '',
    state: 'open',
    headSha: 'a'.repeat(40),
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    files: [],
    filesTruncated: false,
    checks: 'green',
    checkList: [],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    fetchedAt: ts,
    ...extra,
  });
  const result = approvalCommands['pr.inspect'].result;

  it('bounds the inspection strings', () => {
    bounds(result, (v) => inspection({ title: v }), 500);
    bounds(result, (v) => inspection({ body: v }), 64 * 1024);
    bounds(result, (v) => inspection({ mergeable: v }), TEXT_NAME_MAX);
    bounds(result, (v) => inspection({ mergeStateStatus: v }), TEXT_NAME_MAX);
    bounds(
      result,
      (v) =>
        inspection({
          files: [{ path: v, additions: 0, deletions: 0 }],
        }),
      4096,
    );
    bounds(
      result,
      (v) => inspection({ checkList: [{ name: v, state: 'pass' }] }),
      500,
    );
    bounds(
      result,
      (v) => inspection({ checkList: [{ name: 'c', state: 'pass', url: v }] }),
      4096,
    );
    expect(
      result.safeParse(
        inspection({
          checkList: Array(257).fill({ name: 'c', state: 'pass' }),
        }),
      ).success,
    ).toBe(false);
  });
});

describe('github commands', () => {
  it('bounds the polled collectors in the result', () => {
    bounds(
      collectorPollResultSchema,
      (v) => ({ restarted: [v] }),
      TEXT_NAME_MAX,
    );
    expect(
      collectorPollResultSchema.safeParse({
        restarted: Array(4).fill('issues'),
      }).success,
    ).toBe(false);
  });
});
