import type { PlannedTask, PlanQuestion } from '@nautelle/shared';
import {
  afterGrill,
  type CurrentTask,
  draftOf,
  revisedTasks,
  statusOfRound,
} from './plan-apply';

const q = (id: string, blocking: boolean): PlanQuestion => ({
  id,
  title: id,
  question: `${id}?`,
  options: [],
  recommendation: { text: 'yes', why: 'because' },
  blocking,
});

const planned = (
  key: string,
  over: Partial<PlannedTask> = {},
): PlannedTask => ({
  key,
  kind: 'feature',
  title: key,
  summary: `${key} summary`,
  dependsOn: [],
  questions: [],
  ...over,
});

const current = (key: string, over: Partial<CurrentTask>): CurrentTask => ({
  ...draftOf(planned(key)),
  rewriteComment: null,
  ...over,
});

describe('statusOfRound', () => {
  it('is needs_talk with a blocking question, ready otherwise (D6)', () => {
    expect(statusOfRound([q('a', false), q('b', true)])).toBe('needs_talk');
    expect(statusOfRound([q('a', false)])).toBe('ready');
    expect(statusOfRound([])).toBe('ready');
  });
});

describe('afterGrill', () => {
  it('chains the write turn when the conversation is done (D7)', () => {
    expect(afterGrill({ questions: [q('a', true)], done: true })).toEqual({
      status: 'ready',
      questions: [],
      chainWrite: true,
    });
    expect(afterGrill({ questions: [q('a', true)], done: false })).toEqual({
      status: 'needs_talk',
      questions: [q('a', true)],
      chainWrite: false,
    });
  });

  it('holds the write while the design is on and not approved (spec 223 D1)', () => {
    const on = { needed: true, status: 'reviewing' as const };
    expect(afterGrill({ questions: [], done: true }, on)).toEqual({
      status: 'needs_design',
      questions: [],
      chainWrite: false,
    });
    expect(
      afterGrill(
        { questions: [], done: true },
        { needed: true, status: 'approved' },
      ),
    ).toMatchObject({ status: 'ready', chainWrite: true });
  });
});

describe('revisedTasks (D9)', () => {
  const fork = '11111111-1111-4111-8111-111111111111';
  const tasks = [
    current('t1', {
      status: 'approved',
      document: '## Acceptance criteria\n- x',
      sessionId: fork,
    }),
    current('t2', { status: 'rejected' }),
    current('t3', {
      status: 'rewrite_requested',
      rewriteComment: 'smaller',
      document: 'old',
      sessionId: fork,
    }),
  ];

  it('passes frozen tasks through, drops rejected ones, redrafts the rest', () => {
    const next = revisedTasks(tasks, {
      action: 'revise',
      tasks: [
        { key: 't1' },
        planned('t3', { title: 'Smaller', questions: [q('a', true)] }),
        planned('t4'),
      ],
    });
    expect(next.map((t) => [t.key, t.status, t.frozen])).toEqual([
      ['t1', 'approved', true],
      ['t3', 'needs_talk', false],
      ['t4', 'ready', false],
    ]);
    expect(next[0].document).toBe('## Acceptance criteria\n- x');
    expect(next[1]).toMatchObject({
      title: 'Smaller',
      document: null,
      sessionId: fork,
    });
    expect(next[2].sessionId).toBeNull();
  });
});
