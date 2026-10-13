import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractPlannerBlocks,
  PLANNER_MAX_QUESTIONS,
  PLANNER_MAX_TASKS,
  PLANNER_OUTPUT_CONTRACT,
  type PlannerViolationReason,
  parsePlannerOutput,
} from '../index';

const fence = (json: unknown, tag = 'agentdock-plan'): string =>
  `\`\`\`${tag}\n${JSON.stringify(json, null, 2)}\n\`\`\``;

const message = (json: unknown): string =>
  `Here is the plan.\n\n${fence(json)}\n\nAsk me anything.`;

const question = (id: string, blocking = false) => ({
  id,
  title: `Question ${id}`,
  question: 'Soft or hard delete?',
  options: [
    { id: 'soft', label: 'Soft delete', detail: 'Keep a deletedAt column' },
    { id: 'hard', label: 'Hard delete' },
  ],
  recommendation: { optionId: 'soft', text: 'Soft delete', why: 'ADR-0007' },
  blocking,
});

const task = (key: string, dependsOn: string[] = [], kind = 'feature') => ({
  key,
  kind,
  title: `Task ${key}`,
  summary: 'What changes, for whom, and where.',
  dependsOn,
  questions: [],
});

const fixtures = {
  clarify: {
    action: 'clarify',
    questions: [question('q1'), question('q2', true)],
    done: false,
  },
  decompose: {
    action: 'decompose',
    title: 'Facts',
    tasks: [
      task('t1'),
      { ...task('t2', ['t1']), questions: [question('q1', true)] },
      task('t3', ['t1', 't2'], 'bug'),
    ],
  },
  grill: { action: 'grill', taskKey: 't2', questions: [], done: true },
  writeFeature: {
    action: 'write',
    taskKey: 't2',
    document: '# Facts\n\n## Summary\nx\n\n## Acceptance criteria\n- [ ] y\n',
    assumptions: ['Soft delete, per ADR-0007'],
  },
  writeBug: {
    action: 'write',
    taskKey: 't3',
    document: '# Crash\n\n## Reproduction\n1. open\n\n## Expected\n## Actual\n',
    assumptions: [],
  },
  revise: {
    action: 'revise',
    tasks: [{ key: 't1' }, task('t2', ['t1']), task('t4', ['t2'])],
  },
} as const;

const expectViolation = (
  result: { ok: true } | { ok: false; error: { reason: string } },
  reason: PlannerViolationReason,
) => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.reason).toBe(reason);
};

describe('parsePlannerOutput — valid fixtures', () => {
  it('clarify', () => {
    const r = parsePlannerOutput(message(fixtures.clarify), 'clarify');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.questions).toHaveLength(2);
  });

  it('decompose', () => {
    const r = parsePlannerOutput(message(fixtures.decompose), 'decompose');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.tasks.map((t) => t.key)).toEqual(['t1', 't2', 't3']);
      expect(r.output.tasks[1].questions[0].blocking).toBe(true);
    }
  });

  it('grill', () => {
    const r = parsePlannerOutput(message(fixtures.grill), 'grill', {
      taskKey: 't2',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.done).toBe(true);
  });

  it('write, a feature', () => {
    const r = parsePlannerOutput(message(fixtures.writeFeature), 'write', {
      taskKey: 't2',
      taskKind: 'feature',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.assumptions).toHaveLength(1);
  });

  it('write, a bug', () => {
    const r = parsePlannerOutput(message(fixtures.writeBug), 'write', {
      taskKey: 't3',
      taskKind: 'bug',
    });
    expect(r.ok).toBe(true);
  });

  it('revise, with a frozen task passed through by key', () => {
    const r = parsePlannerOutput(message(fixtures.revise), 'revise', {
      frozenKeys: ['t1'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.tasks[0]).toEqual({ key: 't1' });
  });

  it('accepts a ~~~ fence and ignores other fenced blocks around it', () => {
    const text = [
      'Notes:',
      '```ts',
      'const x = "```agentdock-plan";',
      '```',
      '~~~~agentdock-plan',
      JSON.stringify(fixtures.clarify),
      '~~~~',
    ].join('\n');
    expect(parsePlannerOutput(text, 'clarify').ok).toBe(true);
  });
});

describe('parsePlannerOutput — rejections', () => {
  it('zero agentdock-plan blocks', () => {
    expectViolation(
      parsePlannerOutput(
        `no block\n${fence(fixtures.clarify, 'json')}`,
        'clarify',
      ),
      'no_block',
    );
  });

  it('an agentdock-plan block that is never closed', () => {
    const text = `\`\`\`agentdock-plan\n${JSON.stringify(fixtures.clarify)}`;
    expectViolation(parsePlannerOutput(text, 'clarify'), 'no_block');
  });

  it('two agentdock-plan blocks', () => {
    const text = `${fence(fixtures.clarify)}\n\n${fence(fixtures.clarify)}`;
    expectViolation(parsePlannerOutput(text, 'clarify'), 'multiple_blocks');
  });

  it('a block that is not JSON', () => {
    expectViolation(
      parsePlannerOutput('```agentdock-plan\n{ nope\n```', 'clarify'),
      'invalid_json',
    );
  });

  it('an output for another action', () => {
    expectViolation(
      parsePlannerOutput(message(fixtures.clarify), 'decompose'),
      'action_mismatch',
    );
  });

  it('an unknown key at the top level', () => {
    expectViolation(
      parsePlannerOutput(message({ ...fixtures.clarify, extra: 1 }), 'clarify'),
      'unknown_key',
    );
  });

  it('an unknown key in a nested task', () => {
    const tasks = [{ ...task('t1'), priority: 'high' }];
    expectViolation(
      parsePlannerOutput(
        message({ ...fixtures.decompose, tasks }),
        'decompose',
      ),
      'unknown_key',
    );
  });

  it('an unknown key in a revised task', () => {
    const tasks = [{ key: 't1' }, { ...task('t2'), priority: 'high' }];
    expectViolation(
      parsePlannerOutput(message({ action: 'revise', tasks }), 'revise', {
        frozenKeys: ['t1'],
      }),
      'unknown_key',
    );
  });

  it('a dependsOn naming a key that does not exist', () => {
    const tasks = [task('t1'), task('t2', ['t9'])];
    expectViolation(
      parsePlannerOutput(
        message({ ...fixtures.decompose, tasks }),
        'decompose',
      ),
      'unknown_dependency',
    );
  });

  it('a revise dependsOn naming a dropped task', () => {
    const tasks = [{ key: 't1' }, task('t2', ['t3'])];
    expectViolation(
      parsePlannerOutput(message({ action: 'revise', tasks }), 'revise', {
        frozenKeys: ['t1'],
      }),
      'unknown_dependency',
    );
  });

  it('a task that depends on itself', () => {
    const tasks = [task('t1', ['t1'])];
    expectViolation(
      parsePlannerOutput(
        message({ ...fixtures.decompose, tasks }),
        'decompose',
      ),
      'self_dependency',
    );
  });

  it('two tasks with one key', () => {
    const tasks = [task('t1'), task('t1')];
    expectViolation(
      parsePlannerOutput(
        message({ ...fixtures.decompose, tasks }),
        'decompose',
      ),
      'duplicate_task_key',
    );
  });

  it(`more than ${PLANNER_MAX_TASKS} tasks`, () => {
    const tasks = Array.from({ length: PLANNER_MAX_TASKS + 1 }, (_, i) =>
      task(`t${i + 1}`),
    );
    expectViolation(
      parsePlannerOutput(
        message({ ...fixtures.decompose, tasks }),
        'decompose',
      ),
      'too_many_tasks',
    );
    expectViolation(
      parsePlannerOutput(message({ action: 'revise', tasks }), 'revise', {
        frozenKeys: [],
      }),
      'too_many_tasks',
    );
  });

  it(`more than ${PLANNER_MAX_QUESTIONS} questions in a round`, () => {
    const questions = Array.from(
      { length: PLANNER_MAX_QUESTIONS + 1 },
      (_, i) => question(`q${i + 1}`),
    );
    expectViolation(
      parsePlannerOutput(
        message({ ...fixtures.clarify, questions }),
        'clarify',
      ),
      'too_many_questions',
    );
    expectViolation(
      parsePlannerOutput(message({ ...fixtures.grill, questions }), 'grill', {
        taskKey: 't2',
      }),
      'too_many_questions',
    );
    const tasks = [{ ...task('t1'), questions }];
    expectViolation(
      parsePlannerOutput(
        message({ ...fixtures.decompose, tasks }),
        'decompose',
      ),
      'too_many_questions',
    );
  });

  it('more than 6 options, or a recommendation naming no option', () => {
    const many = {
      ...question('q1'),
      options: Array.from({ length: 7 }, (_, i) => ({
        id: `o${i}`,
        label: `Option ${i}`,
      })),
      recommendation: { text: 'o1', why: 'because' },
    };
    expectViolation(
      parsePlannerOutput(
        message({ ...fixtures.clarify, questions: [many] }),
        'clarify',
      ),
      'invalid_shape',
    );
    const dangling = {
      ...question('q1'),
      recommendation: { optionId: 'nope', text: 'x', why: 'y' },
    };
    expectViolation(
      parsePlannerOutput(
        message({ ...fixtures.clarify, questions: [dangling] }),
        'clarify',
      ),
      'invalid_shape',
    );
  });

  it('a missing field', () => {
    const { done: _done, ...rest } = fixtures.clarify;
    expectViolation(
      parsePlannerOutput(message(rest), 'clarify'),
      'invalid_shape',
    );
  });

  it('a feature document without ## Acceptance criteria', () => {
    expectViolation(
      parsePlannerOutput(
        message({ ...fixtures.writeFeature, document: '# x\n\n## Summary\n' }),
        'write',
        { taskKey: 't2', taskKind: 'feature' },
      ),
      'missing_acceptance_criteria',
    );
  });

  it('a bug document without ## Reproduction', () => {
    // The feature heading does not satisfy a bug, nor a deeper heading.
    expectViolation(
      parsePlannerOutput(
        message({
          ...fixtures.writeBug,
          document: '# x\n\n### Reproduction\n\n## Acceptance criteria\n',
        }),
        'write',
        { taskKey: 't3', taskKind: 'bug' },
      ),
      'missing_reproduction',
    );
  });

  it('grill and write about another task', () => {
    expectViolation(
      parsePlannerOutput(message(fixtures.grill), 'grill', { taskKey: 't1' }),
      'task_mismatch',
    );
    expectViolation(
      parsePlannerOutput(message(fixtures.writeFeature), 'write', {
        taskKey: 't1',
        taskKind: 'feature',
      }),
      'task_mismatch',
    );
  });

  it('revise: a frozen task rewritten, missing, or a key ref that is not frozen', () => {
    expectViolation(
      parsePlannerOutput(message(fixtures.revise), 'revise', {
        frozenKeys: ['t1', 't2'],
      }),
      'frozen_task',
    );
    expectViolation(
      parsePlannerOutput(message(fixtures.revise), 'revise', {
        frozenKeys: ['t1', 't5'],
      }),
      'frozen_task',
    );
    expectViolation(
      parsePlannerOutput(message(fixtures.revise), 'revise', {
        frozenKeys: [],
      }),
      'frozen_task',
    );
  });

  it('carries the contract_violation code and a message', () => {
    const r = parsePlannerOutput('nothing', 'clarify');
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'contract_violation',
        reason: 'no_block',
        message: 'no agentdock-plan block',
      },
    });
  });
});

describe('extractPlannerBlocks', () => {
  it('skips a tag quoted inside another fence', () => {
    const text = '````md\n```agentdock-plan\n{}\n```\n````';
    expect(extractPlannerBlocks(text)).toEqual([]);
  });
});

describe('the fixed contract and the default instructions', () => {
  it('the contract text names every action and the block tag', () => {
    for (const action of ['clarify', 'decompose', 'grill', 'write', 'revise']) {
      expect(PLANNER_OUTPUT_CONTRACT).toContain(`"action": "${action}"`);
    }
    expect(PLANNER_OUTPUT_CONTRACT).toContain('agentdock-plan');
  });

  it('default-instructions.md exists and carries the cs-spec rules', () => {
    const body = readFileSync(
      join(__dirname, 'default-instructions.md'),
      'utf8',
    );
    for (const rule of [
      'Evidence before questions',
      'frontier',
      '## Parallel plan',
      '## Contention',
      '## Acceptance criteria',
      '## Reproduction',
    ]) {
      expect(body).toContain(rule);
    }
  });
});
