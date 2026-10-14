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
  SessionEnd: ['session-end', false],
};

const hooksFile = readJson(join(pluginDir, 'hooks/hooks.json')) as {
  hooks: Record<string, HookGroup[]>;
};

describe('manifests', () => {
  test('marketplace lists the plugin at a path that exists', () => {
    const m = readJson(join(repoRoot, '.claude-plugin/marketplace.json')) as {
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    };
    expect(m.name).toBe('agentdock');
    expect(m.owner.name).toBeTruthy();
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0]?.name).toBe('agentdock');
    const source = m.plugins[0]?.source ?? '';
    expect(source.startsWith('./')).toBe(true);
    expect(
      existsSync(join(repoRoot, source, '.claude-plugin/plugin.json')),
    ).toBe(true);
  });

  test('plugin.json is named agentdock', () => {
    const p = readJson(join(pluginDir, '.claude-plugin/plugin.json'));
    expect(p.name).toBe('agentdock');
    expect(typeof p.version).toBe('string');
  });

  test('.mcp.json runs agentdock-runner mcp as server "agentdock"', () => {
    const m = readJson(join(pluginDir, '.mcp.json')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(m.mcpServers.agentdock).toEqual({
      command: 'agentdock-runner',
      args: ['mcp'],
    });
  });

  test('slash commands exist with a description', () => {
    for (const name of ['handoff', 'away']) {
      const text = readFileSync(join(pluginDir, `commands/${name}.md`), 'utf8');
      expect(text.startsWith('---\n')).toBe(true);
      expect(text).toContain('description:');
      expect(text).toContain(`mcp__plugin_agentdock_agentdock__${name}`);
    }
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
      expect(h.command).toBe(
        `command -v agentdock-runner >/dev/null 2>&1 && agentdock-runner hook ${arg} || true`,
      );
      if (sync) {
        expect(h.async).toBeUndefined();
        expect(h.timeout).toBe(event === 'SessionStart' ? 10 : 300);
      } else {
        expect(h.async).toBe(true);
      }
    });
  }
});

describe('hooks are silent without agentdock-runner on PATH', () => {
  // A PATH with only the basics the shell needs, and no agentdock-runner.
  const emptyBin = mkdtempSync(join(tmpdir(), 'agentdock-nobin-'));

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
    const bin = mkdtempSync(join(tmpdir(), 'agentdock-stub-'));
    const log = join(bin, 'argv.log');
    const stub = join(bin, 'agentdock-runner');
    writeFileSync(stub, `#!/bin/sh\necho "$@" > "${log}"\n`);
    chmodSync(stub, 0o755);
    const command = hooksFile.hooks.SessionStart?.[0]?.hooks[0]
      ?.command as string;
    const proc = Bun.spawnSync(['/bin/sh', '-c', command], {
      env: { PATH: `${bin}:${emptyBin}` },
    });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(log, 'utf8').trim()).toBe('hook session-start');
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
