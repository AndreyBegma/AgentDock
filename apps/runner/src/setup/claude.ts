import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConfigProfile } from '../config';
import { legacyPluginInstalled } from '../detect/capabilities';
import type { Exec } from '../detect/exec';
import { type Env, expandHome } from '../env';
import { OTLP_HOST } from '../otlp/receiver';
import { isOtlpHeaders, type OtlpEndpoint, otlpHeaders } from '../otlp/token';

/** The repository marketplace and the plugin in it (spec 201 D21). */
export const MARKETPLACE_SOURCE = 'AndreyBegma/Nautelle';
export const MARKETPLACE_NAME = 'nautelle';
export const PLUGIN_REF = `nautelle@${MARKETPLACE_NAME}`;

/** ADR-0073: the marketplace and plugin names before the rename. */
export const LEGACY_MARKETPLACE_NAME = 'agentdock';
export const LEGACY_PLUGIN_REF = `agentdock@${LEGACY_MARKETPLACE_NAME}`;

/** Plugin commands reach the network; they get longer than a probe. */
export const PLUGIN_COMMAND_TIMEOUT_MS = 120_000;

/**
 * The exporter keys `setup` owns in `settings.json` → `env` (D21). Never
 * `OTEL_RESOURCE_ATTRIBUTES` — the runner sets it per managed launch — and
 * never `OTEL_LOG_*`, which would export prompt and tool content (ADR-0021 §3).
 * The headers carry the receiver's token, which it refuses requests without
 * (L-30).
 */
export const exporterEnv = ({
  port,
  token,
}: OtlpEndpoint): Record<string, string> => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://${OTLP_HOST}:${port}`,
  OTEL_EXPORTER_OTLP_HEADERS: otlpHeaders(token),
});
export const EXPORTER_KEYS = Object.keys(exporterEnv({ port: 0, token: '' }));

/** An endpoint this command could have written, whatever the port was then. */
const OUR_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d+$/;

export interface SetupClaudeOptions {
  profiles: readonly ConfigProfile[];
  /** `--profile <key>`: only that profile. */
  profile?: string;
  telemetry: boolean;
  dryRun: boolean;
  uninstall: boolean;
  /** The OTLP receiver's port and token; null when the receiver is off. */
  otlp: OtlpEndpoint | null;
  home: string;
  env: Env;
  /** An `Exec` running with the given environment. */
  exec: (env: Env) => Exec;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class SetupError extends Error {}

const readSettings = (path: string): Json | null => {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new SetupError(`${path} is not valid JSON; left untouched`);
  }
  if (!isObject(parsed)) {
    throw new SetupError(`${path} is not a JSON object; left untouched`);
  }
  return parsed;
};

const envOf = (settings: Json | null): Record<string, unknown> =>
  settings && isObject(settings.env) ? settings.env : {};

/** Writes atomically, keeping the file's mode (settings may hold secrets). */
const writeAtomic = (path: string, text: string): void => {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
};

const show = (value: unknown): string =>
  value === undefined ? '(unset)' : JSON.stringify(value);

/** The env lines that differ, as `- KEY=old` / `+ KEY=new`. */
export const envDiff = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] => {
  const lines: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (key in before) lines.push(`-  env.${key} = ${show(before[key])}`);
    if (key in after) lines.push(`+  env.${key} = ${show(after[key])}`);
  }
  return lines;
};

/** `settings.json` with the exporter keys merged in; every other key kept. */
export const installedSettings = (
  current: Json | null,
  otlp: OtlpEndpoint,
): Json => {
  const settings: Json = { ...(current ?? {}) };
  settings.env = { ...envOf(current), ...exporterEnv(otlp) };
  return settings;
};

/**
 * `settings.json` with the exporter keys as they were before `setup` (the
 * `.bak` it wrote first), or removed when there is no backup. A key the
 * person changed since is not ours any more and is left alone.
 */
export const uninstalledSettings = (
  current: Json | null,
  backup: Json | null,
): Json | null => {
  if (!current) return null;
  const env = { ...envOf(current) };
  const before = envOf(backup);
  const ours = exporterEnv({ port: 0, token: '' });
  for (const key of EXPORTER_KEYS) {
    const value = env[key];
    const mine =
      key === 'OTEL_EXPORTER_OTLP_ENDPOINT'
        ? typeof value === 'string' && OUR_ENDPOINT.test(value)
        : key === 'OTEL_EXPORTER_OTLP_HEADERS'
          ? isOtlpHeaders(value)
          : value === ours[key];
    if (!mine) continue;
    if (key in before) env[key] = before[key];
    else delete env[key];
  }
  const settings: Json = { ...current };
  if (Object.keys(env).length === 0 && !(backup && 'env' in backup)) {
    delete settings.env;
  } else {
    settings.env = env;
  }
  return settings;
};

/**
 * ADR-0073: removes the plugin installed under its old name, so its hooks do
 * not fire beside the new one's. Run before install and uninstall alike.
 */
const LEGACY_PLUGIN_COMMANDS: readonly string[][] = [
  ['plugin', 'uninstall', LEGACY_PLUGIN_REF, '--scope', 'user'],
  ['plugin', 'marketplace', 'remove', LEGACY_MARKETPLACE_NAME],
];

const pluginCommands = (uninstall: boolean): string[][] =>
  uninstall
    ? [
        ['plugin', 'uninstall', PLUGIN_REF, '--scope', 'user'],
        ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME],
      ]
    : [
        ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE],
        ['plugin', 'install', PLUGIN_REF, '--scope', 'user'],
      ];

/**
 * A command that failed only because the state is already there — an added
 * marketplace, an installed plugin, a removed one. The wording of these
 * messages is not documented [Unknown]; matching it keeps reruns idempotent.
 */
const alreadyDone = (text: string): boolean =>
  /already|not installed|not found/i.test(text);

const configDirOf = (profile: ConfigProfile, home: string): string => {
  const dir = profile.env.CLAUDE_CONFIG_DIR;
  return dir ? expandHome(dir, home) : join(home, '.claude');
};

/**
 * `nautelle-runner setup claude` (spec 201 D21): per Claude profile, with
 * `CLAUDE_CONFIG_DIR` set, installs the `nautelle` plugin from the
 * repository marketplace (argv, never a shell) and merges the exporter keys
 * into the user `settings.json` → `env`. Writes `<settings>.bak` once, before
 * its first change, prints the diff, and changes nothing on a rerun.
 * `--uninstall` reverses both. `--dry-run` prints without running or writing.
 */
export const setupClaude = async (
  options: SetupClaudeOptions,
): Promise<number> => {
  const out = (line: string) => options.stdout(`${line}\n`);
  const claude = options.profiles.filter((p) => p.runtime === 'claude');
  const selected = options.profile
    ? claude.filter((p) => p.id === options.profile)
    : claude;
  if (selected.length === 0) {
    options.stderr(
      options.profile
        ? `No Claude profile ${options.profile}. See \`nautelle-runner profiles\`.\n`
        : 'No Claude profiles configured. Run `nautelle-runner profiles --detect --write` first.\n',
    );
    return 1;
  }
  const telemetry = options.telemetry && !options.uninstall;
  if (telemetry && options.otlp === null) {
    options.stderr(
      'The OTLP receiver is off (otlp.enabled: false); telemetry settings are skipped.\n',
    );
  }

  let failed = false;
  for (const profile of selected) {
    const configDir = configDirOf(profile, options.home);
    const env: Env = {
      ...options.env,
      ...profile.env,
      CLAUDE_CONFIG_DIR: configDir,
    };
    const binary = profile.binary ?? 'claude';
    out(`${profile.id} (CLAUDE_CONFIG_DIR=${configDir})`);

    try {
      if (options.uninstall || telemetry) {
        settingsStep(options, configDir, out);
      }
    } catch (error) {
      if (!(error instanceof SetupError)) throw error;
      options.stderr(`  ${error.message}\n`);
      failed = true;
      continue;
    }

    const exec = options.exec(env);
    const commands = [
      ...(legacyPluginInstalled(configDir) ? LEGACY_PLUGIN_COMMANDS : []),
      ...pluginCommands(options.uninstall),
    ];
    for (const args of commands) {
      const shown = `  $ ${binary} ${args.join(' ')}`;
      out(shown);
      if (options.dryRun) continue;
      const result = await exec(binary, args, {
        timeoutMs: PLUGIN_COMMAND_TIMEOUT_MS,
      });
      if (!result) {
        options.stderr(`  ${binary} not found or timed out\n`);
        failed = true;
        break;
      }
      if (result.code !== 0) {
        const text = `${result.stdout}\n${result.stderr}`.trim();
        if (alreadyDone(text)) {
          out(`    (${text.split('\n')[0]})`);
          continue;
        }
        options.stderr(`  failed (exit ${result.code}): ${text}\n`);
        failed = true;
        break;
      }
    }
  }
  if (options.dryRun) out('Dry run: nothing was run or written.');
  else if (!failed && !options.uninstall) {
    // #348 D7: setup does not talk to the daemon; its next heartbeat sees it.
    out(
      'A running nautelle-runner reports this within 15 seconds. Sessions started before now need a restart to load the plugin.',
    );
  }
  return failed ? 1 : 0;
};

const settingsStep = (
  options: SetupClaudeOptions,
  configDir: string,
  out: (line: string) => void,
): void => {
  const path = join(configDir, 'settings.json');
  const backupPath = `${path}.bak`;
  const current = readSettings(path);
  let next: Json | null;
  if (options.uninstall) {
    next = uninstalledSettings(current, readSettings(backupPath));
  } else {
    if (options.otlp === null) return;
    next = installedSettings(current, options.otlp);
  }
  const diff = envDiff(envOf(current), envOf(next));
  if (!next || diff.length === 0) {
    out(`  ${path}: up to date`);
    return;
  }
  out(`  ${path}:`);
  for (const line of diff) out(`  ${line}`);
  if (options.dryRun) return;
  if (current && !existsSync(backupPath)) {
    writeAtomic(backupPath, readFileSync(path, 'utf8'));
    out(`  backup: ${backupPath}`);
  }
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
};
