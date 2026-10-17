import { describe, expect, it } from 'bun:test';
import type { CardRunArgs } from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';
import {
  CARD_PORT_BASE,
  CARD_PORT_SPAN,
  cardArgv,
  cardEnv,
  cardLaunchSpec,
  cardPort,
  cardWorktreePath,
} from './launch';

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
  | 'session'
  | 'model'
  | 'permissionMode'
  | 'prompt'
  | 'projectId'
  | 'runId'
  | 'shortId'
> => ({
  session: { id: SESSION, resume },
  model: 'opus',
  permissionMode: 'manual',
  prompt: PROMPT,
  projectId: 'prj_1',
  runId: 'run_r2',
  shortId: 'ab12cd34',
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

  it('#113: carries the session token in the env when the runner minted one', () => {
    expect(
      cardLaunchSpec(profile, args(false), '/wt', null).env
        .AGENTDOCK_SESSION_TOKEN,
    ).toBeUndefined();
    const spec = cardLaunchSpec(
      profile,
      args(false),
      '/wt',
      null,
      undefined,
      null,
      'tok-round',
    );
    expect(spec.env.AGENTDOCK_SESSION_TOKEN).toBe('tok-round');
  });

  // #367 D1: checked against Claude Code 2.1.301 — hooks from `--settings`
  // and the server from `--mcp-config` load on `--session-id` and `--resume`.
  it('#367 D1: injected wiring adds --settings and --mcp-config before the model, on both rounds', () => {
    const wiring = {
      settings: '/state/cards/card_1/rounds/run_r2/agentdock-settings.json',
      mcp: '/state/cards/card_1/rounds/run_r2/agentdock-mcp.json',
    };
    for (const resume of [false, true]) {
      const spec = cardLaunchSpec(profile, args(resume), '/wt', null, wiring);
      expect(spec.args.slice(3, 8)).toEqual([
        '--settings',
        wiring.settings,
        '--mcp-config',
        wiring.mcp,
        '--model',
      ]);
      expect(spec.args.slice(-2)).toEqual(['--', PROMPT]);
    }
  });

  it('#367 D2: without wiring there is neither flag', () => {
    const { args: argv } = cardArgv(profile, args(false));
    expect(argv).not.toContain('--settings');
    expect(argv).not.toContain('--mcp-config');
  });

  // #389: two cards running the e2e suite at once wiped each other's test
  // database — the session now says which card it is, on every round.
  it('#389: tells the session its card and a port of its own, on every round', () => {
    for (const resume of [false, true]) {
      const spec = cardLaunchSpec(profile, args(resume), '/wt', null);
      expect(spec.env.AGENTDOCK_CARD).toBe('ab12cd34');
      expect(spec.env.AGENTDOCK_CARD_PORT).toBe(String(cardPort('ab12cd34')));
      expect(spec.env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-work');
    }
  });

  it("#389: the card's env wins over a profile that sets the same names", () => {
    const spec = cardLaunchSpec(
      { ...profile, env: { ...profile.env, AGENTDOCK_CARD: 'other' } },
      args(false),
      '/wt',
      null,
    );
    expect(spec.env.AGENTDOCK_CARD).toBe('ab12cd34');
  });

  it('#389: a card port is stable, in range, and differs between cards', () => {
    expect(cardPort('ab12cd34')).toBe(cardPort('ab12cd34'));
    const ids = ['ab12cd34', 'h74ymwpx', '00000000', 'zzzzzzzz', 'ab12cd35'];
    const ports = ids.map(cardPort);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(CARD_PORT_BASE);
      expect(port).toBeLessThan(CARD_PORT_BASE + CARD_PORT_SPAN);
    }
    expect(new Set(ports).size).toBe(ids.length);
    expect(cardEnv('h74ymwpx')).toEqual({
      AGENTDOCK_CARD: 'h74ymwpx',
      AGENTDOCK_CARD_PORT: String(cardPort('h74ymwpx')),
    });
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
