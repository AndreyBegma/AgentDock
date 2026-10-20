import { describe, expect, it } from 'bun:test';
import type { ConfigProfile } from '../config';
import {
  planTurnArgv,
  planTurnLaunchSpec,
  planTurnSessionName,
  planWorktreePath,
} from './launch';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

const profile: ConfigProfile = {
  id: 'claude-work',
  runtime: 'claude',
  binary: '/opt/claude',
  env: { CLAUDE_CONFIG_DIR: '/home/p/.claude-work' },
  args: ['--strict-mcp-config'],
};

const TAIL = [
  '--model',
  'opus',
  '--permission-mode',
  'plan',
  '--output-format',
  'stream-json',
  '--verbose',
];

describe('plan turn launch (D3, D15, D16)', () => {
  it('starts the plan session with --session-id', () => {
    expect(
      planTurnArgv(profile, {
        session: { id: S1, resume: false },
        model: 'opus',
      }),
    ).toEqual({
      binary: '/opt/claude',
      args: ['--strict-mcp-config', '-p', '--session-id', S1, ...TAIL],
    });
  });

  it('resumes it with --resume on later turns', () => {
    expect(
      planTurnArgv(profile, {
        session: { id: S1, resume: true },
        model: 'opus',
      }).args,
    ).toEqual(['--strict-mcp-config', '-p', '--resume', S1, ...TAIL]);
  });

  it('forks a task from the plan session with the id the API chose', () => {
    expect(
      planTurnArgv(profile, {
        session: { id: S2, resume: true, forkFrom: S1 },
        model: 'opus',
      }).args,
    ).toEqual([
      '--strict-mcp-config',
      '-p',
      '--resume',
      S1,
      '--fork-session',
      '--session-id',
      S2,
      ...TAIL,
    ]);
  });

  it('feeds the prompt file on stdin and runs in the plan worktree', () => {
    const spec = planTurnLaunchSpec(
      profile,
      {
        session: { id: S1, resume: false },
        model: 'sonnet',
        projectId: 'prj_widget',
        runId: 'run_1',
      },
      '/ws/.wt-widget-plan-abc12345',
      '/state/plans/plan_1/turns/turn_1/prompt.md',
      null,
    );
    expect(spec.cwd).toBe('/ws/.wt-widget-plan-abc12345');
    expect(spec.stdin).toBe('/state/plans/plan_1/turns/turn_1/prompt.md');
    expect(spec.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/home/p/.claude-work',
      OTEL_RESOURCE_ATTRIBUTES:
        'agentdock.project=prj_widget,agentdock.run=run_1',
    });
    expect(spec.args).toContain('sonnet');
  });

  it('names the worktree beside the checkout and the session by the turn', () => {
    expect(planWorktreePath('/ws/widget/', 'abc12345')).toBe(
      '/ws/.wt-widget-plan-abc12345',
    );
    expect(planTurnSessionName('abc12345')).toBe('nautelle-plan-abc12345');
  });
});
