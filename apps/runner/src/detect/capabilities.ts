import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Capabilities } from '@agentdock/shared/protocol';
import { z } from 'zod';
import type { ConfigProfile, RunnerConfig } from '../config';
import type { Exec } from './exec';
import { claudeConfigDir, withAuthentication } from './profiles';

/** The first dotted version in a tool's output: `tmux 3.5a` → `3.5a`. */
export const extractVersion = (text: string): string | null =>
  text.match(/\d+(?:\.\d+)+[0-9A-Za-z.+-]*/)?.[0] ?? null;

const versionOf = async (
  exec: Exec,
  binary: string,
  args: readonly string[],
): Promise<string | null> => {
  const result = await exec(binary, args);
  if (!result || result.code !== 0) return null;
  return extractVersion(`${result.stdout}\n${result.stderr}`);
};

/** `gh auth status` names the account as `account <user>` (≥ 2.40) or `as <user>`. */
export const parseGhUser = (text: string): string | null =>
  text.match(/Logged in to \S+ (?:account|as) ([A-Za-z0-9-]+)/)?.[1] ?? null;

const detectGh = async (exec: Exec): Promise<Capabilities['gh']> => {
  const version = await versionOf(exec, 'gh', ['--version']);
  if (!version) return null;
  const status = await exec('gh', ['auth', 'status']);
  const authenticated = status?.code === 0;
  return {
    version,
    authenticated,
    user:
      authenticated && status
        ? parseGhUser(`${status.stdout}\n${status.stderr}`)
        : null,
  };
};

const installedPluginsSchema = z.object({
  plugins: z.record(
    z.string(),
    z.array(
      z.object({
        version: z.string().min(1),
        installPath: z.string().min(1),
        scope: z.string().optional(),
      }),
    ),
  ),
});

/**
 * The code-sentinel plugin claude has installed for this profile, from
 * `<CLAUDE_CONFIG_DIR>/plugins/installed_plugins.json`; null when absent or
 * unreadable — never a guess.
 */
export const readCodeSentinel = (
  configDir: string,
): Capabilities['codeSentinel'] => {
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(
        join(configDir, 'plugins', 'installed_plugins.json'),
        'utf8',
      ),
    );
  } catch {
    return null;
  }
  const parsed = installedPluginsSchema.safeParse(raw);
  if (!parsed.success) return null;
  for (const [key, installs] of Object.entries(parsed.data.plugins)) {
    if (!key.startsWith('code-sentinel@')) continue;
    const install =
      installs.find((i) => i.scope === 'user') ?? installs[0] ?? null;
    if (install) return { version: install.version, path: install.installPath };
  }
  return null;
};

/** `a.b.c` ≥ `min`, comparing the leading numbers; an unparsable version is not. */
export const versionAtLeast = (
  version: string | null,
  min: readonly number[],
): boolean => {
  const parts = version
    ?.match(/^\d+(?:\.\d+)*/)?.[0]
    .split('.')
    .map(Number);
  if (!parts) return false;
  for (let i = 0; i < min.length; i++) {
    const have = parts[i] ?? 0;
    if (have !== min[i]) return have > (min[i] ?? 0);
  }
  return true;
};

/** `attach-session -f ignore-size` needs tmux 3.2 (spec 29 D4). */
export const TERMINAL_MIN_TMUX = [3, 2] as const;
/** `Bun.spawn({ terminal })` landed in Bun 1.3.5 (spec 29 D3). */
export const TERMINAL_MIN_BUN = [1, 3, 5] as const;

/** Whether this process has Bun's PTY API: a recent Bun, on POSIX. */
export const ptyAvailable = (): boolean =>
  process.platform !== 'win32' &&
  typeof Bun.Terminal === 'function' &&
  versionAtLeast(Bun.version, TERMINAL_MIN_BUN);

/** Why `terminal.attach` cannot run here, or null when it can (D3). */
export const terminalUnsupported = (
  tmux: string | null,
  pty: boolean,
): string | null => {
  if (!pty) return 'this runner has no PTY API (Bun ≥ 1.3.5 on POSIX)';
  if (!versionAtLeast(tmux, TERMINAL_MIN_TMUX)) {
    return `tmux ${tmux ?? 'is missing'}; attaching needs tmux ≥ 3.2`;
  }
  return null;
};

/**
 * `capabilities.terminal` (spec 29 D3, D10): the machine can attach and the
 * runner config does not list `terminal.attach` in `disabledCommands`.
 */
export const terminalCapability = (options: {
  tmux: string | null;
  disabledCommands: readonly string[];
  pty: boolean;
}): boolean =>
  !options.disabledCommands.includes('terminal.attach') &&
  terminalUnsupported(options.tmux, options.pty) === null;

export interface DetectOptions {
  exec: Exec;
  home: string;
  config: Pick<RunnerConfig, 'profiles' | 'otlp'>;
}

/** Everything `hello` reports about the machine (D5). Never throws for a missing tool. */
export const detectCapabilities = async (
  options: DetectOptions,
): Promise<Capabilities> => {
  const { exec, home, config } = options;
  const [tmux, git, gh, claude, codex] = await Promise.all([
    versionOf(exec, 'tmux', ['-V']),
    versionOf(exec, 'git', ['--version']),
    detectGh(exec),
    versionOf(exec, 'claude', ['--version']),
    versionOf(exec, 'codex', ['--version']),
  ]);

  const claudeProfiles: ConfigProfile[] = config.profiles.filter(
    (p) => p.runtime === 'claude',
  );
  const codeSentinel =
    claudeProfiles
      .map((p) => readCodeSentinel(claudeConfigDir(p, home)))
      .find((found) => found !== null) ?? null;

  return {
    tmux,
    git,
    gh,
    runtimes: {
      claude: claude ? { version: claude } : null,
      codex: codex ? { version: codex } : null,
    },
    profiles: withAuthentication(config.profiles, home),
    codeSentinel,
    otlp: config.otlp,
  };
};
