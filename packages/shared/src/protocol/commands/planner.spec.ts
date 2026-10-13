import { describe, expect, it } from 'bun:test';
import {
  commands,
  PLAN_QUEUE_ISSUES_MAX,
  PLAN_TURN_PROMPT_MAX_BYTES,
  planCancelArgsSchema,
  planCloseArgsSchema,
  planDocsBranch,
  plannerCommands,
  planPublishSpecsArgsSchema,
  planPublishSpecsResultSchema,
  planQueueIssuesArgsSchema,
  planTurnArgsSchema,
  planTurnResultSchema,
} from '../index';

const PLAN_SESSION = '0f5a3c1e-8a2b-4c6d-9e0f-1a2b3c4d5e6f';
const FORK_SESSION = '1e2d3c4b-5a69-4788-9a6b-5c4d3e2f1a0b';

const turn = {
  planId: 'cmplan0001',
  turnId: 'cmturn0001',
  runId: 'cmrun0001',
  projectId: 'prj_1',
  root: '/home/dev/repo',
  base: 'develop',
  session: { id: PLAN_SESSION, resume: false },
  prompt: '# Planner instructions\n\nAction: decompose\n',
  profileKey: 'blacktoorroot',
  model: 'opus',
  timeoutSec: 1200,
};

const publish = {
  planId: 'cmplan0001',
  projectId: 'prj_1',
  root: '/home/dev/repo',
  base: 'develop',
  specDir: 'docs/specs',
  branch: 'docs/plan-a1b2c3d4',
  files: [
    { path: 'docs/specs/201-facts.md', content: '# Facts\n' },
    { path: 'docs/specs/202-export.md', content: '# Export\n' },
  ],
  title: 'docs(specs): plan a1b2c3d4',
  body: 'Specifications of plan a1b2c3d4.',
};

const pathError = (args: unknown): boolean =>
  !planPublishSpecsArgsSchema.safeParse(args).success;

describe('planner commands', () => {
  it('are defined for the runner to register with its handlers', () => {
    expect(Object.keys(plannerCommands).sort()).toEqual([
      'plan.cancel',
      'plan.close',
      'plan.publish_specs',
      'plan.queue_issues',
      'plan.turn',
    ]);
    // Registered together with the runner's handlers (i172-runner), as skills were.
    for (const name of Object.keys(plannerCommands)) {
      expect(Object.hasOwn(commands, name)).toBe(false);
    }
  });

  it('all need an operator and carry a timeout', () => {
    for (const definition of Object.values(plannerCommands)) {
      expect(definition.minRole).toBe('operator');
      expect(definition.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('refuse unknown keys in every command', () => {
    const valid = {
      'plan.turn': turn,
      'plan.cancel': { planId: 'cmplan0001', turnId: 'cmturn0001' },
      'plan.close': { planId: 'cmplan0001', projectId: 'prj_1' },
      'plan.publish_specs': publish,
      'plan.queue_issues': { projectId: 'prj_1', numbers: [201, 202] },
    } as const;
    for (const [name, args] of Object.entries(valid)) {
      const schema = plannerCommands[name as keyof typeof plannerCommands].args;
      expect(schema.safeParse(args).success).toBe(true);
      expect(schema.safeParse({ ...args, shell: 'rm -rf /' }).success).toBe(
        false,
      );
    }
  });
});

describe('plan.turn', () => {
  it('accepts the first turn, a resumed turn and a fork (D3)', () => {
    expect(planTurnArgsSchema.safeParse(turn).success).toBe(true);
    expect(
      planTurnArgsSchema.safeParse({
        ...turn,
        session: { id: PLAN_SESSION, resume: true },
      }).success,
    ).toBe(true);
    expect(
      planTurnArgsSchema.safeParse({
        ...turn,
        session: { id: FORK_SESSION, resume: true, forkFrom: PLAN_SESSION },
      }).success,
    ).toBe(true);
  });

  it('refuses a fork that does not resume, or that reuses the plan session id', () => {
    for (const session of [
      { id: FORK_SESSION, resume: false, forkFrom: PLAN_SESSION },
      { id: PLAN_SESSION, resume: true, forkFrom: PLAN_SESSION },
      { id: 'not-a-uuid', resume: false },
    ]) {
      expect(planTurnArgsSchema.safeParse({ ...turn, session }).success).toBe(
        false,
      );
    }
  });

  it(`caps the prompt at ${PLAN_TURN_PROMPT_MAX_BYTES} bytes, counted in UTF-8, and refuses NUL or an empty one`, () => {
    const at = 'a'.repeat(PLAN_TURN_PROMPT_MAX_BYTES);
    expect(planTurnArgsSchema.safeParse({ ...turn, prompt: at }).success).toBe(
      true,
    );
    const over = 'é'.repeat(PLAN_TURN_PROMPT_MAX_BYTES / 2 + 1);
    for (const prompt of [over, 'a\u0000b', '  \n']) {
      expect(planTurnArgsSchema.safeParse({ ...turn, prompt }).success).toBe(
        false,
      );
    }
  });

  it('refuses an option-like model, a relative root and an out-of-range timeout', () => {
    for (const patch of [
      { model: '--dangerously-skip-permissions' },
      { root: 'repo' },
      { base: '-x' },
      { timeoutSec: 10 },
      { timeoutSec: 100_000 },
    ]) {
      expect(planTurnArgsSchema.safeParse({ ...turn, ...patch }).success).toBe(
        false,
      );
    }
  });

  it('reports queued or running', () => {
    expect(planTurnResultSchema.safeParse({ phase: 'queued' }).success).toBe(
      true,
    );
    expect(planTurnResultSchema.safeParse({ phase: 'succeeded' }).success).toBe(
      false,
    );
  });
});

describe('plan.cancel and plan.close', () => {
  it('take only ids', () => {
    expect(
      planCancelArgsSchema.safeParse({ planId: '../x', turnId: 't' }).success,
    ).toBe(false);
    expect(planCloseArgsSchema.safeParse({ planId: 'p' }).success).toBe(false);
  });
});

describe('plan.publish_specs', () => {
  it('accepts files under specDir', () => {
    expect(planPublishSpecsArgsSchema.safeParse(publish).success).toBe(true);
  });

  it('refuses a path outside specDir', () => {
    for (const path of [
      'README.md',
      'docs/specs.md',
      'docs/specsX/201-facts.md',
      'docs/201-facts.md',
    ]) {
      expect(pathError({ ...publish, files: [{ path, content: 'x' }] })).toBe(
        true,
      );
    }
  });

  it('refuses a path containing ..', () => {
    for (const path of [
      'docs/specs/../../.github/workflows/x.md',
      'docs/specs/..md',
      'docs/specs/a..b.md',
      '/docs/specs/201-facts.md',
      'docs/specs/./201-facts.md',
      'docs\\specs\\201-facts.md',
    ]) {
      expect(pathError({ ...publish, files: [{ path, content: 'x' }] })).toBe(
        true,
      );
    }
  });

  it('refuses a specDir that escapes the repository', () => {
    for (const specDir of ['../docs', '/docs/specs', 'docs/specs/', '.', '']) {
      expect(
        pathError({
          ...publish,
          specDir,
          files: [{ path: `${specDir}/1-x.md`, content: 'x' }],
        }),
      ).toBe(true);
    }
  });

  it('refuses a duplicate path, a non-markdown file, a foreign branch, no files', () => {
    const [first] = publish.files;
    expect(pathError({ ...publish, files: [first, first] })).toBe(true);
    expect(
      pathError({
        ...publish,
        files: [{ path: 'docs/specs/run.sh', content: 'x' }],
      }),
    ).toBe(true);
    expect(pathError({ ...publish, branch: 'main' })).toBe(true);
    expect(pathError({ ...publish, files: [] })).toBe(true);
  });

  it('names the docs branch from the plan short id', () => {
    expect(planDocsBranch('a1b2c3d4')).toBe('docs/plan-a1b2c3d4');
    expect(() => planDocsBranch('../x')).toThrow();
  });

  it('returns an https pull request', () => {
    expect(
      planPublishSpecsResultSchema.safeParse({
        prNumber: 12,
        prUrl: 'https://github.com/o/r/pull/12',
      }).success,
    ).toBe(true);
    expect(
      planPublishSpecsResultSchema.safeParse({
        prNumber: 12,
        prUrl: 'javascript:alert(1)',
      }).success,
    ).toBe(false);
  });
});

describe('plan.queue_issues', () => {
  it(`takes 1–${PLAN_QUEUE_ISSUES_MAX} unique positive numbers`, () => {
    const ok = (numbers: number[]) =>
      planQueueIssuesArgsSchema.safeParse({ projectId: 'prj_1', numbers })
        .success;
    expect(ok([1, 2, 3])).toBe(true);
    expect(ok([])).toBe(false);
    expect(ok([1, 1])).toBe(false);
    expect(ok([0])).toBe(false);
    expect(
      ok(Array.from({ length: PLAN_QUEUE_ISSUES_MAX + 1 }, (_, i) => i + 1)),
    ).toBe(false);
  });
});
