import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CardStore } from './cards/record';
import { loadConfig } from './config';
import { findOrchestratorSession } from './control/orchestrator';
import { resolvePaths } from './env';
import {
  adoptLegacyEnv,
  legacyDirMoves,
  legacyEnvAdoptions,
  legacyReportLines,
  migrateDir,
  migrateLegacyDirs,
} from './legacy';
import { localSocketPath } from './local/paths';
import { loadSessionTokenSecret } from './local/session-tokens';
import { tempDir } from './testing/fixtures';

/**
 * ADR-0073: a machine upgraded from `agentdock-runner` keeps its projects,
 * its policy and its live sessions under the new names.
 */
describe('the upgrade from the agentdock names (ADR-0073)', () => {
  let dir = '';
  let cleanup = () => {};
  let env: Record<string, string> = {};

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    env = {
      HOME: join(dir, 'home'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_STATE_HOME: join(dir, 'state'),
      XDG_RUNTIME_DIR: join(dir, 'run'),
    };
  });
  afterEach(() => cleanup());

  const POLICY = {
    allowedRoots: ['/home/u/dev'],
    maxPermissionMode: 'auto',
    terminal: { write: true },
  };
  const SECRET = Buffer.alloc(32, 7);
  const CARD = {
    cardId: 'card_1',
    projectId: 'prj_a',
    root: '/home/u/dev/app',
    repo: 'acme/app',
    shortId: 'ab12cd34',
    worktree: '/home/u/dev/.wt-app-card-ab12cd34',
    branch: 'card/c1-login',
    base: 'develop',
    tmuxSession: 'agentdock-card-ab12cd34',
    runId: 'run_1',
    phase: 'running',
    startedAt: '2026-10-01T10:00:00.000Z',
  };

  /** What a 0.13 runner leaves: config, state and a runtime socket dir. */
  const writeOldMachine = () => {
    const config = join(dir, 'config', 'agentdock');
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, 'runner.json'),
      JSON.stringify({
        projects: [{ id: 'prj_a', root: '/home/u/dev/app' }],
        policy: POLICY,
      }),
    );
    const state = join(dir, 'state', 'agentdock');
    mkdirSync(join(state, 'cards', 'card_1'), { recursive: true });
    writeFileSync(join(state, 'session-token.key'), SECRET);
    writeFileSync(
      join(state, 'cards', 'card_1', 'state.json'),
      JSON.stringify(CARD),
    );
    mkdirSync(join(dir, 'run', 'agentdock'), { recursive: true });
    writeFileSync(join(dir, 'run', 'agentdock', 'runner.sock'), '');
  };

  it('moves the config, state and runtime directories and links the old paths back', () => {
    writeOldMachine();
    const report = migrateLegacyDirs(env, 'linux');
    expect(report.moved.map((m) => m.to)).toEqual([
      join(dir, 'config', 'nautelle'),
      join(dir, 'state', 'nautelle'),
      join(dir, 'run', 'nautelle'),
    ]);
    expect(report.both).toEqual([]);
    expect(report.failed).toEqual([]);
    for (const { from, to } of report.moved) {
      expect(lstatSync(from).isSymbolicLink()).toBe(true);
      expect(readlinkSync(from)).toBe(to);
      expect(lstatSync(to).isDirectory()).toBe(true);
    }
  });

  it('keeps the watched projects and the policy', () => {
    writeOldMachine();
    migrateLegacyDirs(env, 'linux');
    const config = loadConfig(resolvePaths(env).configFile);
    expect(config.projects).toEqual([{ id: 'prj_a', root: '/home/u/dev/app' }]);
    expect(config.policy.allowedRoots).toEqual(POLICY.allowedRoots);
    expect(config.policy.maxPermissionMode).toBe('auto');
    expect(config.policy.terminal.write).toBe(true);
  });

  it('keeps the session-token secret, so live sessions still verify', () => {
    writeOldMachine();
    migrateLegacyDirs(env, 'linux');
    const paths = resolvePaths(env);
    expect(
      loadSessionTokenSecret(join(paths.stateDir, 'session-token.key')),
    ).toEqual(SECRET);
    // A hook of a session started before the upgrade reaches the socket by
    // its old path.
    expect(localSocketPath(env, 'linux', paths.stateDir)).toBe(
      join(dir, 'run', 'nautelle', 'runner.sock'),
    );
    expect(existsSync(join(dir, 'run', 'agentdock', 'runner.sock'))).toBe(true);
  });

  it('keeps watching a card session that runs under its old tmux name', () => {
    writeOldMachine();
    migrateLegacyDirs(env, 'linux');
    const store = new CardStore(join(resolvePaths(env).stateDir, 'cards'));
    expect(store.load('card_1')?.tmuxSession).toBe('agentdock-card-ab12cd34');
  });

  it('finds an orchestrator an older runner started', async () => {
    const live = new Set(['agentdock-orch-acme-app']);
    const tmux = {
      find: async (name: string) =>
        live.has(name) ? { name, createdAt: null } : null,
    };
    expect(await findOrchestratorSession(tmux, 'acme/app')).toBe(
      'agentdock-orch-acme-app',
    );
    live.add('nautelle-orch-acme-app');
    expect(await findOrchestratorSession(tmux, 'acme/app')).toBe(
      'nautelle-orch-acme-app',
    );
    live.clear();
    expect(await findOrchestratorSession(tmux, 'acme/app')).toBeNull();
  });

  it('is idempotent: a second start moves nothing', () => {
    writeOldMachine();
    migrateLegacyDirs(env, 'linux');
    expect(migrateLegacyDirs(env, 'linux')).toEqual({
      moved: [],
      both: [],
      failed: [],
    });
  });

  it('leaves both in place when the new directory already exists', () => {
    writeOldMachine();
    mkdirSync(join(dir, 'config', 'nautelle'), { recursive: true });
    const report = migrateLegacyDirs(env, 'linux');
    expect(report.both).toEqual([
      {
        from: join(dir, 'config', 'agentdock'),
        to: join(dir, 'config', 'nautelle'),
      },
    ]);
    expect(lstatSync(join(dir, 'config', 'agentdock')).isDirectory()).toBe(
      true,
    );
    expect(
      readFileSync(join(dir, 'config', 'agentdock', 'runner.json'), 'utf8'),
    ).toContain('prj_a');
  });

  it('does nothing on a fresh machine', () => {
    expect(migrateLegacyDirs(env, 'linux')).toEqual({
      moved: [],
      both: [],
      failed: [],
    });
    expect(existsSync(join(dir, 'config', 'nautelle'))).toBe(false);
  });

  it('has no runtime directory to move on macOS', () => {
    expect(legacyDirMoves(env, 'darwin').map((m) => m.to)).toEqual([
      join(dir, 'config', 'nautelle'),
      join(dir, 'state', 'nautelle'),
    ]);
  });

  it('counts a directory another process moved first as moved', () => {
    const from = join(dir, 'a', 'agentdock');
    const to = join(dir, 'a', 'nautelle');
    mkdirSync(from, { recursive: true });
    expect(migrateDir({ from, to })).toBe('moved');
    expect(migrateDir({ from, to })).toBe('none');
  });
});

describe('the AGENTDOCK_* variables (ADR-0073)', () => {
  it('count as their NAUTELLE_* names, and the new name wins', () => {
    expect(
      legacyEnvAdoptions({
        AGENTDOCK_LOG: 'debug',
        AGENTDOCK_RAW: '1',
        NAUTELLE_RAW: '0',
        PATH: '/bin',
      }),
    ).toEqual({ NAUTELLE_LOG: 'debug' });
  });

  it('are adopted into the environment once, and the old names reported', () => {
    const env: Record<string, string | undefined> = {
      AGENTDOCK_SESSION_TOKEN: 'tok',
      AGENTDOCK_HOOKS: 'off',
    };
    expect(adoptLegacyEnv(env)).toEqual([
      'AGENTDOCK_HOOKS',
      'AGENTDOCK_SESSION_TOKEN',
    ]);
    expect(env.NAUTELLE_SESSION_TOKEN).toBe('tok');
    expect(env.NAUTELLE_HOOKS).toBe('off');
    expect(adoptLegacyEnv(env)).toEqual([]);
  });

  it('log one deprecation line each', () => {
    const lines = legacyReportLines({
      env: ['AGENTDOCK_LOG'],
      moved: [{ from: '/c/agentdock', to: '/c/nautelle' }],
      both: [],
      failed: [],
    });
    expect(lines).toEqual([
      'AGENTDOCK_LOG is deprecated: set NAUTELLE_LOG instead; runner 0.16.0 stops reading the old name (ADR-0073)',
      'moved /c/agentdock to /c/nautelle and left a symlink (ADR-0073)',
    ]);
  });
});
