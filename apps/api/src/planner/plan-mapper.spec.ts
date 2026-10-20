import type { PlannedTask, PlanQuestion } from '@nautelle/shared';
import { roundsOf } from './plan-mapper';

const q = (id: string): PlanQuestion => ({
  id,
  title: id,
  question: `${id}?`,
  options: [],
  recommendation: { text: 'yes', why: 'because' },
  blocking: false,
});

const planned = (key: string, questions: PlanQuestion[]): PlannedTask => ({
  key,
  kind: 'feature',
  title: key,
  summary: `${key} summary`,
  dependsOn: [],
  questions,
});

describe('roundsOf', () => {
  it('reads a clarify round as plan-level, and none once done', () => {
    const output = { action: 'clarify', questions: [q('a')], done: false };
    expect(roundsOf('clarify', output, null)).toEqual([
      { taskKey: null, questions: [q('a')] },
    ]);
    expect(roundsOf('clarify', { ...output, done: true }, null)).toEqual([]);
  });

  it("reads a grill round as its task's, and none once done", () => {
    const output = {
      action: 'grill',
      taskKey: 't1',
      questions: [q('b')],
      done: false,
    };
    expect(roundsOf('grill', output, 't1')).toEqual([
      { taskKey: 't1', questions: [q('b')] },
    ]);
    expect(roundsOf('grill', { ...output, done: true }, 't1')).toEqual([]);
  });

  it("reads each new or changed task's first round from a decompose or revise", () => {
    const decompose = {
      action: 'decompose',
      title: 'Plan',
      tasks: [planned('t1', [q('a')]), planned('t2', [])],
    };
    expect(roundsOf('decompose', decompose, null)).toEqual([
      { taskKey: 't1', questions: [q('a')] },
    ]);
    const revise = {
      action: 'revise',
      tasks: [{ key: 't1' }, planned('t3', [q('c')])],
    };
    expect(roundsOf('revise', revise, null)).toEqual([
      { taskKey: 't3', questions: [q('c')] },
    ]);
  });

  it('opens no round for a write, no output, or an output that no longer parses', () => {
    expect(
      roundsOf(
        'write',
        { action: 'write', taskKey: 't1', document: 'x', assumptions: [] },
        't1',
      ),
    ).toEqual([]);
    expect(roundsOf('grill', null, 't1')).toEqual([]);
    expect(roundsOf('grill', { action: 'grill', extra: 1 }, 't1')).toEqual([]);
  });
});
