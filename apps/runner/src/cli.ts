import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import type { Host } from '@agentdock/shared/protocol';
import { runClaude } from './claude';
import type { Clock } from './clock';
import { ConfigError, isPaired, loadConfig, saveConfig } from './config';
import type { RunnerConnection, SocketFactory } from './connection';
import { runDaemon } from './daemon';
import { createExec, type Exec } from './detect/exec';
import { detectProfiles, withAuthentication } from './detect/profiles';
import { type Env, type Paths, resolvePaths } from './env';
import { runHook } from './hooks/run';
import { runAway } from './local/away';
import { localSocketPath } from './local/paths';
import { type LocalCommandDeps, NotImplementedError } from './local/subcommand';
import { LockError } from './lock';
import { createLogger, errorMessage, type Logger, parseLogLevel } from './log';
import { runMcp } from './mcp';
import { otlpSettings } from './otlp';
import { PairingError, pair } from './pairing';
import { normalizeServer, ServerUrlError } from './server-url';
import { EXIT, launchAgentPlist, serviceUnit } from './service';
import { setupClaude } from './setup/claude';
import { Spool } from './spool';
import { RUNNER_VERSION } from './version';

export interface CliDeps {
  env: Env;
  host: Host;
  clock: Clock;
  fetch: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The command a service manager runs to start the daemon, `run` included. */
  execStart: readonly string[];
  exec?: Exec;
  createSocket?: SocketFactory;
  random?: () => number;
  signal?: AbortSignal;
  onStart?: (connection: RunnerConnection) => void;
  /** The process's stdin, for `hook` and `mcp`; Bun's by default. */
  stdin?: () => ReadableStream<Uint8Array>;
  /** The working directory; `process.cwd()` by default. */
  cwd?: string;
  /** The parent pid; `process.ppid` by default. */
  ppid?: number;
}

const USAGE = `Usage: agentdock-runner <command>

Commands:
  pair --server <url> --code <XXXX-XXXX> [--no-detect]
                                           pair this machine with an AgentDock server
                                           (detects runtime profiles unless --no-detect)
  run                                      run the daemon in the foreground
  status                                   show config, connectivity and spool
  profiles [--detect [--write]]            list runtime profiles, or detect them
  install-service                          write the systemd user unit (Linux)
                                           or the launchd agent (macOS)
  setup claude [--profile <key>] [--no-telemetry] [--dry-run] [--uninstall]
                                           install the agentdock Claude Code plugin
                                           and point telemetry at this runner
  away on|off                              route permission prompts to AgentDock
                                           while you are away
  version                                  print the version and the target

Used by the agentdock Claude Code plugin:
  hook <name>                              report a Claude Code hook (JSON on stdin)
  mcp                                      the agentdock MCP server (stdio)
  claude [-- <args>]                       run claude in a tmux session AgentDock
                                           can attach to
`;

class UsageError extends Error {}

interface Context {
  deps: CliDeps;
  paths: Paths;
  log: Logger;
  args: string[];
}

const out = (deps: CliDeps, line: string) => deps.stdout(`${line}\n`);

type FlagOptions = Record<string, { type: 'string' | 'boolean' }>;

const flags = <T extends FlagOptions>(args: string[], options: T) =>
  withPositionals(args, options, 0).values;

/** Strict flags plus up to `max` positionals; more is a usage error. */
const withPositionals = <T extends FlagOptions>(
  args: string[],
  options: T,
  max: number,
) => {
  const parsed = (() => {
    try {
      return parseArgs({ args, options, strict: true, allowPositionals: true });
    } catch (error) {
      throw new UsageError(errorMessage(error));
    }
  })();
  if (parsed.positionals.length > max) {
    throw new UsageError(
      `unexpected argument: ${parsed.positionals[max] ?? ''}`,
    );
  }
  return parsed;
};

const pairCommand = async ({
  deps,
  paths,
  log,
  args,
}: Context): Promise<number> => {
  const {
    server,
    code,
    'no-detect': noDetect,
  } = flags(args, {
    server: { type: 'string' },
    code: { type: 'string' },
    'no-detect': { type: 'boolean' },
  });
  if (!server || !code) throw new UsageError('pair needs --server and --code');
  const origin = normalizeServer(server);
  const config = loadConfig(paths.configFile);

  const paired = await pair({
    server: origin,
    code,
    hostname: deps.host.hostname,
    runnerVersion: RUNNER_VERSION,
    fetch: deps.fetch,
  });
  log.addSecret(paired.token);
  if (config.runnerId && config.runnerId !== paired.runnerId) {
    log.info('replacing the previous pairing', {
      previousRunnerId: config.runnerId,
    });
  }
  // Existing profiles are never overwritten; detection fills an empty list only.
  const detected =
    !noDetect && config.profiles.length === 0
      ? detectProfiles(deps.env, paths.home)
      : null;
  saveConfig(paths.configFile, {
    ...config,
    server: origin,
    runnerId: paired.runnerId,
    token: paired.token,
    profiles: detected ?? config.profiles,
    // Sessions are ingested from pairing on, unless a backfill asks (D11).
    sessions: {
      ...config.sessions,
      ingestSince:
        config.sessions.ingestSince ?? new Date(deps.clock.now()).toISOString(),
    },
  });
  log.info('paired', { runnerId: paired.runnerId, server: origin });
  out(
    deps,
    `Paired as ${paired.runnerId}. Config written to ${paths.configFile}`,
  );
  if (detected) {
    out(deps, `Detected ${detected.length} profiles:`);
    for (const p of withAuthentication(detected, paths.home)) {
      out(
        deps,
        `  ${p.id}  ${p.runtime}  ${p.authenticated ? 'authenticated' : 'not authenticated'}`,
      );
    }
  }
  return EXIT.ok;
};

const runCommand = async ({
  deps,
  paths,
  log,
  args,
}: Context): Promise<number> => {
  flags(args, {});
  const config = loadConfig(paths.configFile);
  if (!isPaired(config)) {
    deps.stderr(
      'Not paired. Run `agentdock-runner pair --server <url> --code <code>` first.\n',
    );
    return EXIT.failure;
  }
  log.addSecret(config.token);
  if (config.profiles.length === 0) {
    log.warn(
      'no runtime profiles configured; nothing can be launched. Run `agentdock-runner profiles --detect --write`',
    );
  }
  const reason = await runDaemon({
    config,
    configFile: paths.configFile,
    localSocket: socketPathOf(deps, paths),
    home: paths.home,
    spoolDir: paths.spoolDir,
    offsetsFile: paths.offsetsFile,
    host: deps.host,
    exec: deps.exec ?? createExec(deps.env),
    clock: deps.clock,
    log,
    createSocket: deps.createSocket,
    random: deps.random,
    signal: deps.signal,
    onStart: deps.onStart,
  });
  return reason.kind === 'terminal' ? EXIT.terminalClose : EXIT.ok;
};

const statusCommand = async ({
  deps,
  paths,
  log,
  args,
}: Context): Promise<number> => {
  flags(args, {});
  const config = loadConfig(paths.configFile);
  if (config.token) log.addSecret(config.token);
  const spool = Spool.inspect(paths.spoolDir);
  out(deps, `config:   ${paths.configFile}`);
  out(
    deps,
    `paired:   ${isPaired(config) ? `yes, as ${config.runnerId}` : 'no'}`,
  );
  out(deps, `server:   ${config.server ?? '-'}`);
  out(deps, `profiles: ${config.profiles.length}`);
  out(
    deps,
    `spool:    ${spool.segments} segment(s), ${spool.bytes} bytes, last seq ${spool.lastSeq}, acked ${spool.ackedSeq}`,
  );
  if (config.server) {
    try {
      const response = await deps.fetch(config.server, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      });
      out(deps, `reach:    reachable (HTTP ${response.status})`);
    } catch (error) {
      out(deps, `reach:    unreachable — ${errorMessage(error)}`);
      return EXIT.failure;
    }
  }
  return EXIT.ok;
};

const profilesCommand = async ({
  deps,
  paths,
  args,
}: Context): Promise<number> => {
  const { detect, write } = flags(args, {
    detect: { type: 'boolean' },
    write: { type: 'boolean' },
  });
  if (write && !detect) throw new UsageError('--write needs --detect');
  const config = loadConfig(paths.configFile);
  if (!detect) {
    if (config.profiles.length === 0) {
      deps.stderr(
        'No profiles configured. Try `agentdock-runner profiles --detect`.\n',
      );
    }
    out(
      deps,
      JSON.stringify(withAuthentication(config.profiles, paths.home), null, 2),
    );
    return EXIT.ok;
  }
  const proposed = detectProfiles(deps.env, paths.home);
  out(deps, JSON.stringify(withAuthentication(proposed, paths.home), null, 2));
  if (write) {
    saveConfig(paths.configFile, { ...config, profiles: proposed });
    deps.stderr(`Wrote ${proposed.length} profiles to ${paths.configFile}\n`);
  }
  return EXIT.ok;
};

const installServiceCommand = async ({
  deps,
  paths,
  args,
}: Context): Promise<number> => {
  flags(args, {});
  if (deps.host.os === 'darwin') {
    mkdirSync(dirname(paths.launchAgentFile), { recursive: true });
    mkdirSync(dirname(paths.launchAgentLog), { recursive: true });
    writeFileSync(
      paths.launchAgentFile,
      launchAgentPlist(deps.execStart, paths.launchAgentLog, deps.env.PATH),
      { mode: 0o644 },
    );
    out(deps, `Wrote ${paths.launchAgentFile}`);
    out(
      deps,
      `Load it with: launchctl bootstrap gui/$UID ${paths.launchAgentFile}`,
    );
    out(deps, `Logs: ${paths.launchAgentLog}`);
    return EXIT.ok;
  }
  mkdirSync(dirname(paths.serviceFile), { recursive: true });
  writeFileSync(paths.serviceFile, serviceUnit(deps.execStart, deps.env.PATH), {
    mode: 0o644,
  });
  out(deps, `Wrote ${paths.serviceFile}`);
  out(
    deps,
    'Enable it with: systemctl --user daemon-reload && systemctl --user enable --now agentdock-runner',
  );
  return EXIT.ok;
};

/** The daemon's socket, derived exactly as the daemon derives it (spec 201 D5). */
const socketPathOf = (deps: CliDeps, paths: Paths): string =>
  localSocketPath(deps.env, deps.host.os, dirname(paths.spoolDir));

const localDeps = (deps: CliDeps, paths: Paths): LocalCommandDeps => ({
  env: deps.env,
  os: deps.host.os,
  socketPath: socketPathOf(deps, paths),
  cwd: deps.cwd ?? process.cwd(),
  ppid: deps.ppid ?? process.ppid,
  stdin: deps.stdin ?? (() => Bun.stdin.stream()),
  stdout: deps.stdout,
  stderr: deps.stderr,
  exec: deps.exec ?? createExec(deps.env),
});

const setupCommand = async ({
  deps,
  paths,
  args,
}: Context): Promise<number> => {
  const { values, positionals } = withPositionals(
    args,
    {
      profile: { type: 'string' },
      'no-telemetry': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      uninstall: { type: 'boolean' },
    },
    1,
  );
  if (positionals[0] !== 'claude') {
    throw new UsageError('setup needs a target: setup claude');
  }
  const config = loadConfig(paths.configFile);
  const otlp = otlpSettings(config.otlp);
  return setupClaude({
    profiles: config.profiles,
    profile: values.profile,
    telemetry: !values['no-telemetry'],
    dryRun: values['dry-run'] === true,
    uninstall: values.uninstall === true,
    otlpPort: otlp.enabled ? otlp.httpPort : null,
    home: paths.home,
    env: deps.env,
    exec: (env) => createExec(env),
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
};

const COMMANDS: Record<string, (context: Context) => Promise<number>> = {
  pair: pairCommand,
  run: runCommand,
  status: statusCommand,
  profiles: profilesCommand,
  'install-service': installServiceCommand,
  setup: setupCommand,
  away: ({ deps, paths, args }) => runAway(args, localDeps(deps, paths)),
  // `mcp` and `claude` take their arguments raw: the wave-3 slots own them.
  mcp: ({ deps, paths, args }) => runMcp(args, localDeps(deps, paths)),
  claude: ({ deps, paths, args }) => runClaude(args, localDeps(deps, paths)),
};

/** The whole CLI, with every side effect injected. Returns the exit code. */
export const runCli = async (
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> => {
  const [command, ...args] = argv;
  if (command === 'version' || command === '--version' || command === '-v') {
    out(deps, `${RUNNER_VERSION} ${deps.host.os}-${deps.host.arch}`);
    return EXIT.ok;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    deps.stdout(USAGE);
    return EXIT.ok;
  }
  // A hook must never fail the session it reports: exit 0 whatever happens,
  // and log nothing (spec 201 D12).
  if (command === 'hook') {
    try {
      return await runHook(args, localDeps(deps, resolvePaths(deps.env)));
    } catch {
      return EXIT.ok;
    }
  }
  const handler = command ? COMMANDS[command] : undefined;
  if (!handler) {
    deps.stderr(command ? `Unknown command: ${command}\n\n${USAGE}` : USAGE);
    return EXIT.usage;
  }

  const log = createLogger({
    level: parseLogLevel(deps.env),
    write: deps.stderr,
    now: () => new Date(deps.clock.now()),
  });
  try {
    return await handler({ deps, paths: resolvePaths(deps.env), log, args });
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    if (error instanceof NotImplementedError) {
      deps.stderr(`${error.message}\n`);
      return EXIT.failure;
    }
    if (
      error instanceof PairingError ||
      error instanceof ConfigError ||
      error instanceof ServerUrlError ||
      error instanceof LockError
    ) {
      log.error(error.message);
      return EXIT.failure;
    }
    log.error('unexpected failure', { error: errorMessage(error) });
    return EXIT.failure;
  }
};
