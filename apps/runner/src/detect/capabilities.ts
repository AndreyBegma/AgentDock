import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Capabilities,
  ProfileAgentdock,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import type { ConfigProfile, RunnerConfig } from '../config';
import { profileMcpServerNames } from '../launch/profile-mcp';
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

/** The installed version of `agentdock@*` — user scope first — or null. */
const readAgentdockPlugin = (configDir: string): string | null => {
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
    if (!key.startsWith('agentdock@')) continue;
    const install =
      installs.find((i) => i.scope === 'user') ?? installs[0] ?? null;
    if (install) return install.version;
  }
  return null;
};

const settingsEnvSchema = z.object({
  env: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Whether `settings.json` → `env.OTEL_EXPORTER_OTLP_ENDPOINT` points at the
 * runner's OTLP http port on this machine (#281 D1). False when the receiver
 * is off, the file is unreadable, or the endpoint names another host or port.
 */
const readTelemetry = (configDir: string, port: number | null): boolean => {
  if (port === null) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
  } catch {
    return false;
  }
  const parsed = settingsEnvSchema.safeParse(raw);
  const endpoint = parsed.success
    ? parsed.data.env?.OTEL_EXPORTER_OTLP_ENDPOINT
    : undefined;
  if (typeof endpoint !== 'string') return false;
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      Number(url.port) === port
    );
  } catch {
    return false;
  }
};

/**
 * The agentdock plugin and telemetry state of one Claude profile (#281 D1),
 * read from its config directory — never a guess.
 */
export const readProfileAgentdock = (
  configDir: string,
  otlpPort: number | null,
): ProfileAgentdock => ({
  plugin: readAgentdockPlugin(configDir),
  telemetry: readTelemetry(configDir, otlpPort),
});

/**
 * Every Claude profile's agentdock state, by profile id (#348 D4) — the
 * heartbeat's `profiles`. Reads two JSON files per profile and runs nothing;
 * a Codex profile is never in it.
 */
export const readClaudeProfilesAgentdock = (
  profiles: readonly ConfigProfile[],
  home: string,
  otlpPort: number | null,
): Record<string, ProfileAgentdock> =>
  Object.fromEntries(
    profiles
      .filter((p) => p.runtime === 'claude')
      .map((p) => [
        p.id,
        readProfileAgentdock(claudeConfigDir(p, home), otlpPort),
      ]),
  );

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

/**
 * `capabilities.commands` / `disabledCommands` (#233): every command this
 * build serves (its handler keys) and the subset the config switches off.
 * A name in `disabledCommands` this build does not serve is dropped.
 */
export const commandsCapability = (
  handlers: Readonly<Record<string, unknown>>,
  disabledCommands: readonly string[],
): { commands: string[]; disabledCommands: string[] } => {
  const commands = Object.keys(handlers).sort();
  const served = new Set(commands);
  return {
    commands,
    disabledCommands: [...new Set(disabledCommands)]
      .filter((name) => served.has(name))
      .sort(),
  };
};

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
    // C-123: env names only — the config's values stay on this machine.
    profiles: withAuthentication(config.profiles, home).map((profile, i) => {
      const configured = config.profiles[i];
      return configured?.runtime === 'claude'
        ? {
            ...profile,
            agentdock: readProfileAgentdock(
              claudeConfigDir(configured, home),
              config.otlp?.http ?? null,
            ),
            // #445 Amendment 2: names only, from the profile's own config.
            mcpServers: profileMcpServerNames(configured, home),
          }
        : profile;
    }),
    codeSentinel,
    otlp: config.otlp,
    // #445 Amendment 4: this runner takes `tokenSaver` on launch commands.
    tokenSaver: true,
    // #447: this runner observes for Steward and takes its commands.
    steward: true,
    // #449: this runner keeps handoff notes and takes `card.handoff.set`.
    handoff: true,
    // #489: this runner takes `session.message` and reports question screens.
    sessionMessage: true,
  };
};
