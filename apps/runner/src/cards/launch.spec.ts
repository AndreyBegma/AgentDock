import { describe, expect, it } from 'bun:test';
import type { CardRunArgs } from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';
import { cardArgv, cardLaunchSpec, cardWorktreePath } from './launch';

const profile: ConfigProfile = {
  id: 'claude-work',
  runtime: 'claude',
  binary: '/usr/local/bin/claude',
  env: { CLAUDE_CONFIG_DIR: '/home/u/.claude-work' },
  args: ['--strict-mcp-config'],
};

const SESSION = '3bb1739e-1a1c-4baa-b8b4-a4b1e6700361';
const PROMPT = '-p looks like a flag; $(rm -rf ~) `x` "q"\nsecond line';

const args = (
  resume: boolean,
): Pick<
  CardRunArgs,
  'session' | 'model' | 'permissionMode' | 'prompt' | 'projectId' | 'runId'
> => ({
  session: { id: SESSION, resume },
  model: 'opus',
  permissionMode: 'manual',
  prompt: PROMPT,
  projectId: 'prj_1',
  runId: 'run_r2',
});

describe('card worker launch (#242 D5)', () => {
  it('puts the worktree beside the main checkout', () => {
    expect(cardWorktreePath('/srv/dev/app/', 'ab12cd34')).toBe(
      '/srv/dev/.wt-app-card-ab12cd34',
    );
  });

  // The D5 Unknown, answered against Claude Code 2.1.300: `claude [options]
  // [prompt]` starts interactive with the prompt submitted, with
  // `--session-id` and with `--resume`. `--` ends the options, so the prompt
  // is one argv element whatever it starts with.
  it('round 1: --session-id <uuid>, interactive (no -p), prompt last after --', () => {
    expect(cardArgv(profile, args(false))).toEqual({
      binary: '/usr/local/bin/claude',
      args: [
        '--strict-mcp-config',
        '--session-id',
        SESSION,
        '--model',
        'opus',
        '--permission-mode',
        'default',
        '--',
        PROMPT,
      ],
    });
  });

  it('a later round: --resume <uuid> with the round prompt', () => {
    const { args: argv } = cardArgv(profile, args(true));
    expect(argv.slice(1, 3)).toEqual(['--resume', SESSION]);
    expect(argv).not.toContain('--session-id');
    expect(argv).not.toContain('-p');
    expect(argv.slice(-2)).toEqual(['--', PROMPT]);
  });

  it("is an interactive launch spec carrying the round's run id", () => {
    const spec = cardLaunchSpec(profile, args(true), '/srv/dev/wt', 4318);
    expect(spec.interactive).toBe(true);
    expect(spec.cwd).toBe('/srv/dev/wt');
    expect(spec.stdin).toBeUndefined();
    expect(spec.env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-work');
    expect(spec.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'agentdock.project=prj_1,agentdock.run=run_r2',
    );
    expect(spec.env.OTEL_EXPORTER_OTLP_ENDPOINT).toContain(':4318');
  });

  it('maps every permission mode to the CLI value', () => {
    const modes = {
      auto: 'auto',
      acceptEdits: 'acceptEdits',
      bypassPermissions: 'bypassPermissions',
      manual: 'default',
    } as const;
    for (const [mode, cli] of Object.entries(modes)) {
      const { args: argv } = cardArgv(profile, {
        ...args(false),
        permissionMode: mode as keyof typeof modes,
      });
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe(cli);
    }
  });
});
