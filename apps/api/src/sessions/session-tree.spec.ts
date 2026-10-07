import { Prisma } from '@prisma/client';
import {
  buildSessionTree,
  type RequestRow,
  type SessionRow,
  type ToolRow,
} from './session-tree';

const t = (s: number) => new Date(Date.UTC(2026, 9, 7, 18, 0, s));

const session = (
  id: string,
  parentSessionId: string | null = null,
): SessionRow => ({
  id,
  runnerId: 'rn',
  runtime: 'claude',
  profileKey: null,
  externalId: id,
  projectId: 'p',
  projectName: 'widget',
  slotName: null,
  cwd: '/srv',
  gitBranch: null,
  title: null,
  models: ['m', 7, null],
  parentSessionId,
  parsed: true,
  startedAt: t(0),
  lastEventAt: t(10),
  endedAt: null,
});

const request = (
  id: string,
  sessionId: string,
  input: number,
  costUsd: string | null = null,
): RequestRow => ({
  id,
  sessionId,
  turnId: null,
  requestId: id,
  ts: t(1),
  model: 'm',
  querySource: 'main',
  input,
  output: 1,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  durationMs: null,
  durationApprox: false,
  stopReason: null,
  costUsd: costUsd === null ? null : new Prisma.Decimal(costUsd),
});

const tool = (
  id: string,
  sessionId: string,
  child: string | null,
): ToolRow => ({
  id,
  sessionId,
  turnId: null,
  toolUseId: id,
  name: 'Task',
  startedAt: t(2),
  endedAt: null,
  ok: null,
  childSessionId: child,
});

describe('buildSessionTree', () => {
  it('places a child linked by two tool calls once, and keeps the sum', () => {
    const tree = buildSessionTree('root', {
      sessions: [session('root'), session('kid', 'root')],
      turns: [],
      requests: [
        request('r1', 'root', 10, '0.5'),
        request('r2', 'kid', 5, '0.25'),
      ],
      tools: [tool('t1', 'root', 'kid'), tool('t2', 'root', 'kid')],
    });
    expect(
      tree?.unattributed.tools.map((x) => x.child?.session.id ?? null),
    ).toEqual(['kid', null]);
    expect(tree?.subagents).toEqual([]);
    expect(tree?.totals).toMatchObject({
      input: 15,
      output: 2,
      requests: 2,
      costUsd: '0.75',
    });
    expect(tree?.session.subagents).toBe(1);
    expect(tree?.session.models).toEqual(['m']);
  });

  it('terminates on a cycle of parent links', () => {
    const tree = buildSessionTree('a', {
      sessions: [session('a', 'b'), session('b', 'a')],
      turns: [],
      requests: [request('r1', 'a', 1), request('r2', 'b', 2)],
      tools: [],
    });
    expect(tree?.subagents.map((s) => s.session.id)).toEqual(['b']);
    expect(tree?.subagents[0].subagents).toEqual([]);
    expect(tree?.totals.input).toBe(3);
  });

  it('leaves cost null when no request is priced', () => {
    const tree = buildSessionTree('root', {
      sessions: [session('root')],
      turns: [],
      requests: [request('r1', 'root', 1)],
      tools: [],
    });
    expect(tree?.totals.costUsd).toBeNull();
  });

  it('returns null for an unknown root', () => {
    expect(
      buildSessionTree('nope', {
        sessions: [],
        turns: [],
        requests: [],
        tools: [],
      }),
    ).toBeNull();
  });
});
