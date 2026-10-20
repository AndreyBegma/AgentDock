import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigProfile } from '../config';
import {
  CARD_WIRING_FILES,
  cardHooksSettings,
  cardMcpConfig,
  wireCardRound,
} from './wiring';

/** The plugin the injected wiring stands in for (#367 D1). */
const PLUGIN_HOOKS = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'plugins',
  'nautelle',
  'hooks',
  'hooks.json',
);

interface PluginHook {
  type: string;
  command: string;
  timeout?: number;
  async?: boolean;
}
type Hooks = Record<string, { hooks: PluginHook[] }[]>;

const SELF = ['/opt/nautelle/bin/nautelle-runner'];

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'nautelle-wiring-'));
  dirs.push(dir);
  return dir;
};

const profileIn = (configDir: string): ConfigProfile => ({
  id: 'claude-work',
  runtime: 'claude',
  env: { CLAUDE_CONFIG_DIR: configDir },
  args: [],
});

describe('card wiring (#367 D1, D2)', () => {
  it("carries every hook of the plugin's hooks.json, with its options, calling the runner by absolute path", () => {
    const plugin = (
      JSON.parse(readFileSync(PLUGIN_HOOKS, 'utf8')) as {
        hooks: Hooks;
      }
    ).hooks;
    const injected = cardHooksSettings(SELF).hooks;
    expect(Object.keys(injected)).toEqual(Object.keys(plugin));
    for (const [event, groups] of Object.entries(plugin)) {
      const theirs = groups[0]?.hooks[0];
      const ours = injected[event]?.[0]?.hooks[0];
      if (!theirs || !ours) throw new Error(`${event} has no hook`);
      expect(ours.timeout).toBe(theirs.timeout);
      expect(ours.async === true).toBe(theirs.async === true);
      const subcommand = theirs.command.match(
        /nautelle-runner (hook [a-z-]+) \|\| true$/,
      )?.[1];
      expect(subcommand).toBeDefined();
      expect(ours.command).toBe(
        `/opt/nautelle/bin/nautelle-runner ${subcommand} || true`,
      );
    }
  });

  it('quotes a runner path the shell would split', () => {
    const settings = cardHooksSettings([
      "/home/o'neil/my bin/bun",
      '/a/main.ts',
    ]);
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
      `'/home/o'\\''neil/my bin/bun' /a/main.ts hook stop || true`,
    );
  });

  it("is the plugin's MCP server under the plugin's name", () => {
    expect(cardMcpConfig(['/usr/bin/bun', '/a/main.ts'])).toEqual({
      mcpServers: {
        nautelle: { command: '/usr/bin/bun', args: ['/a/main.ts', 'mcp'] },
      },
    });
  });

  it('writes both files into the round for a profile without the plugin', () => {
    const roundDir = temp();
    const wiring = wireCardRound(profileIn(temp()), '/home/u', roundDir, SELF);
    expect(wiring).toEqual({
      wiring: 'injected',
      files: {
        settings: join(roundDir, CARD_WIRING_FILES.settings),
        mcp: join(roundDir, CARD_WIRING_FILES.mcp),
      },
    });
    expect(
      JSON.parse(
        readFileSync(join(roundDir, CARD_WIRING_FILES.settings), 'utf8'),
      ),
    ).toEqual(cardHooksSettings(SELF));
    expect(
      JSON.parse(readFileSync(join(roundDir, CARD_WIRING_FILES.mcp), 'utf8')),
    ).toEqual(cardMcpConfig(SELF));
  });

  it('writes nothing for a profile that reports the plugin', () => {
    const configDir = temp();
    mkdirSync(join(configDir, 'plugins'));
    writeFileSync(
      join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'nautelle@nautelle': [{ version: '0.9.2', installPath: '/x' }],
        },
      }),
    );
    const roundDir = temp();
    expect(
      wireCardRound(profileIn(configDir), '/home/u', roundDir, SELF),
    ).toEqual({ wiring: 'plugin' });
    expect(() =>
      readFileSync(join(roundDir, CARD_WIRING_FILES.settings)),
    ).toThrow();
  });

  it('writes nothing for a profile with the plugin under its old name (ADR-0073)', () => {
    const configDir = temp();
    mkdirSync(join(configDir, 'plugins'));
    writeFileSync(
      join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'agentdock@agentdock': [{ version: '0.3.0', installPath: '/x' }],
        },
      }),
    );
    expect(
      wireCardRound(profileIn(configDir), '/home/u', temp(), SELF),
    ).toEqual({ wiring: 'plugin' });
  });

  it('is unwired with the reason when the round directory cannot be written', () => {
    // A regular file where the round directory should be: ENOTDIR, for root
    // too (CI runs as root, which ignores a read-only mode).
    const roundDir = join(temp(), 'not-a-directory');
    writeFileSync(roundDir, '');
    expect(wireCardRound(profileIn(temp()), '/home/u', roundDir, SELF)).toEqual(
      { wiring: 'none', wiringReason: 'settings_write_failed' },
    );
  });
});
