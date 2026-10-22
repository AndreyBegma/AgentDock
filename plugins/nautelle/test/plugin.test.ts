import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const pluginDir = resolve(import.meta.dir, '..');
const repoRoot = resolve(pluginDir, '../..');

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8'));

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
  async?: boolean;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

// event -> [runner argument, sync?]. The kebab-case arguments are the contract
// with the runner (spec 201, D12).
const EVENTS: Record<string, [string, boolean]> = {
  SessionStart: ['session-start', true],
  PermissionRequest: ['permission-request', true],
  UserPromptSubmit: ['user-prompt-submit', false],
  PostToolUse: ['post-tool-use', false],
  PostToolUseFailure: ['post-tool-use-failure', false],
  Notification: ['notification', false],
  Stop: ['stop', false],
  PreCompact: ['pre-compact', false],
  SessionEnd: ['session-end', false],
};

const hooksFile = readJson(join(pluginDir, 'hooks/hooks.json')) as {
  hooks: Record<string, HookGroup[]>;
};

const mcpServer = (): { command: string; args: string[] } =>
  (
    readJson(join(pluginDir, '.mcp.json')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    }
  ).mcpServers.nautelle as { command: string; args: string[] };

/**
 * C-162: the hook command runs the runner `setup claude` wrote as
 * NAUTELLE_RUNNER_BIN, and the `nautelle-runner` on PATH only without one.
 */
const hookCommand = (arg: string): string =>
  'r=$NAUTELLE_RUNNER_BIN; case $r in /*) [ -x "$r" ] ;; *) false ;; esac' +
  ` || r=$(command -v nautelle-runner) || exit 0; "$r" hook ${arg} || true`;

/** A fake runner in a fresh directory that logs its argv. */
const fakeRunner = (): { bin: string; stub: string; log: string } => {
  const bin = mkdtempSync(join(tmpdir(), 'nautelle-stub-'));
  const log = join(bin, 'argv.log');
  const stub = join(bin, 'nautelle-runner');
  writeFileSync(stub, `#!/bin/sh\necho "$@" > "${log}"\n`);
  chmodSync(stub, 0o755);
  return { bin, stub, log };
};

describe('manifests', () => {
  test('marketplace lists the plugin at a path that exists', () => {
    const m = readJson(join(repoRoot, '.claude-plugin/marketplace.json')) as {
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    };
    expect(m.name).toBe('nautelle');
    expect(m.owner.name).toBeTruthy();
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0]?.name).toBe('nautelle');
    const source = m.plugins[0]?.source ?? '';
    expect(source.startsWith('./')).toBe(true);
    expect(
      existsSync(join(repoRoot, source, '.claude-plugin/plugin.json')),
    ).toBe(true);
  });

  test('plugin.json is named nautelle', () => {
    const p = readJson(join(pluginDir, '.claude-plugin/plugin.json'));
    expect(p.name).toBe('nautelle');
    expect(typeof p.version).toBe('string');
  });

  test('.mcp.json runs the runner mcp as server "nautelle" through /bin/sh (C-162)', () => {
    const server = mcpServer();
    expect(server.command).toBe('/bin/sh');
    expect(server.args[0]).toBe('-c');
    expect(server.args[1]).toEndWith('exec "$r" mcp');
    // Claude Code expands `${VAR}` in .mcp.json; the script must not use it.
    expect(server.args[1]).not.toContain('${');
  });

  test('slash commands exist with a description', () => {
    for (const name of ['handoff', 'away']) {
      const text = readFileSync(join(pluginDir, `commands/${name}.md`), 'utf8');
      expect(text.startsWith('---\n')).toBe(true);
      expect(text).toContain('description:');
      expect(text).toContain(`mcp__plugin_nautelle_nautelle__${name}`);
    }
  });
});

describe('track-work skill (#282)', () => {
  const skill = readFileSync(
    join(pluginDir, 'skills/track-work/SKILL.md'),
    'utf8',
  );

  test('has frontmatter naming the skill, with a description', () => {
    expect(skill.startsWith('---\n')).toBe(true);
    const front = skill.split('---')[1] ?? '';
    expect(front).toContain('name: track-work');
    expect(front).toContain('description:');
  });

  test('tells the model to call track_card once and what is not work', () => {
    expect(skill).toContain('mcp__plugin_nautelle_nautelle__track_card');
    expect(skill).toContain('once');
    expect(skill).toContain('Questions');
    expect(skill).toContain('not_a_manual_session');
  });

  test('plugin version is bumped for the absolute runner path (C-162)', () => {
    const p = readJson(join(pluginDir, '.claude-plugin/plugin.json'));
    expect(p.version).toBe('0.5.0');
  });
});

describe('hooks.json shape', () => {
  test('declares exactly the spec events', () => {
    expect(Object.keys(hooksFile.hooks).sort()).toEqual(
      Object.keys(EVENTS).sort(),
    );
  });

  for (const [event, [arg, sync]] of Object.entries(EVENTS)) {
    test(`${event}: one command hook calling "hook ${arg}"`, () => {
      const groups = hooksFile.hooks[event] ?? [];
      expect(groups).toHaveLength(1);
      const entries = groups[0]?.hooks ?? [];
      expect(entries).toHaveLength(1);
      const h = entries[0] as HookEntry;
      expect(h.type).toBe('command');
      expect(h.command).toBe(hookCommand(arg));
      if (sync) {
        expect(h.async).toBeUndefined();
        expect(h.timeout).toBe(event === 'SessionStart' ? 10 : 300);
      } else {
        expect(h.async).toBe(true);
      }
    });
  }
});

describe('hooks are silent without nautelle-runner on PATH', () => {
  // A PATH with only the basics the shell needs, and no nautelle-runner.
  const emptyBin = mkdtempSync(join(tmpdir(), 'nautelle-nobin-'));

  for (const [event, groups] of Object.entries(hooksFile.hooks)) {
    test(event, () => {
      const command = groups[0]?.hooks[0]?.command as string;
      const proc = Bun.spawnSync(['/bin/sh', '-c', command], {
        env: { PATH: emptyBin },
        stdin: new TextEncoder().encode('{}'),
      });
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toBe('');
      expect(proc.stderr.toString()).toBe('');
    });
  }

  test('with the binary present, the hook is invoked with the event argument', () => {
    const { bin, log } = fakeRunner();
    const command = hooksFile.hooks.SessionStart?.[0]?.hooks[0]
      ?.command as string;
    const proc = Bun.spawnSync(['/bin/sh', '-c', command], {
      env: { PATH: `${bin}:${emptyBin}` },
    });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(log, 'utf8').trim()).toBe('hook session-start');
  });
});

describe('the runner path setup writes (C-162)', () => {
  const command = hooksFile.hooks.SessionStart?.[0]?.hooks[0]
    ?.command as string;
  const runHook = (env: Record<string, string>) =>
    Bun.spawnSync(['/bin/sh', '-c', command], { env });
  const runMcp = (env: Record<string, string>) =>
    Bun.spawnSync([mcpServer().command, ...mcpServer().args], { env });

  test('the hook runs NAUTELLE_RUNNER_BIN, not the nautelle-runner on PATH', () => {
    const pinned = fakeRunner();
    const shadow = fakeRunner();
    const proc = runHook({
      PATH: shadow.bin,
      NAUTELLE_RUNNER_BIN: pinned.stub,
    });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(pinned.log, 'utf8').trim()).toBe('hook session-start');
    expect(existsSync(shadow.log)).toBe(false);
  });

  test('a missing or relative NAUTELLE_RUNNER_BIN falls back to PATH', () => {
    for (const value of ['/nonexistent/nautelle-runner', 'nautelle-runner']) {
      const fallback = fakeRunner();
      const proc = runHook({ PATH: fallback.bin, NAUTELLE_RUNNER_BIN: value });
      expect(proc.exitCode).toBe(0);
      expect(readFileSync(fallback.log, 'utf8').trim()).toBe(
        'hook session-start',
      );
    }
  });

  test('the MCP server runs NAUTELLE_RUNNER_BIN mcp', () => {
    const pinned = fakeRunner();
    const shadow = fakeRunner();
    const proc = runMcp({ PATH: shadow.bin, NAUTELLE_RUNNER_BIN: pinned.stub });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(pinned.log, 'utf8').trim()).toBe('mcp');
    expect(existsSync(shadow.log)).toBe(false);
  });

  test('without NAUTELLE_RUNNER_BIN the MCP server runs nautelle-runner from PATH', () => {
    for (const env of [{}, { NAUTELLE_RUNNER_BIN: '/nonexistent/x' }]) {
      const fallback = fakeRunner();
      const proc = runMcp({ PATH: fallback.bin, ...env });
      expect(proc.exitCode).toBe(0);
      expect(readFileSync(fallback.log, 'utf8').trim()).toBe('mcp');
    }
  });
});

describe('claude plugin validate', () => {
  const claude = Bun.which('claude');
  test.skipIf(!claude)('accepts the marketplace and the plugin', () => {
    for (const target of [repoRoot, pluginDir]) {
      const proc = Bun.spawnSync([
        claude as string,
        'plugin',
        'validate',
        target,
      ]);
      expect(proc.exitCode).toBe(0);
    }
  });
});
