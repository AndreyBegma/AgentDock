import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import type { Host } from '@agentdock/shared/protocol';
import type { Clock } from './clock';
import { ConfigError, isPaired, loadConfig, saveConfig } from './config';
import type { RunnerConnection, SocketFactory } from './connection';
import { runDaemon } from './daemon';
import { createExec, type Exec } from './detect/exec';
import { detectProfiles, withAuthentication } from './detect/profiles';
import { type Env, type Paths, resolvePaths } from './env';
import { LockError } from './lock';
import { createLogger, errorMessage, type Logger, parseLogLevel } from './log';
import { PairingError, pair } from './pairing';
import { normalizeServer, ServerUrlError } from './server-url';
import { EXIT, serviceUnit } from './service';
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
}

const USAGE = `Usage: agentdock-runner <command>

Commands:
  pair --server <url> --code <XXXX-XXXX> [--no-detect]
                                           pair this machine with an AgentDock server
                                           (detects runtime profiles unless --no-detect)
  run                                      run the daemon in the foreground
  status                                   show config, connectivity and spool
  profiles [--detect [--write]]            list runtime profiles, or detect them
  install-service                          write the systemd user unit
  version                                  print the version
`;

class UsageError extends Error {}

interface Context {
  deps: CliDeps;
  paths: Paths;
  log: Logger;
  args: string[];
}

const out = (deps: CliDeps, line: string) => deps.stdout(`${line}\n`);

const flags = <T extends Record<string, { type: 'string' | 'boolean' }>>(
  args: string[],
  options: T,
) => {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false })
      .values;
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
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
    home: paths.home,
    spoolDir: paths.spoolDir,
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
  mkdirSync(dirname(paths.serviceFile), { recursive: true });
  writeFileSync(paths.serviceFile, serviceUnit(deps.execStart), {
    mode: 0o644,
  });
  out(deps, `Wrote ${paths.serviceFile}`);
  out(
    deps,
    'Enable it with: systemctl --user daemon-reload && systemctl --user enable --now agentdock-runner',
  );
  return EXIT.ok;
};

const COMMANDS: Record<string, (context: Context) => Promise<number>> = {
  pair: pairCommand,
  run: runCommand,
  status: statusCommand,
  profiles: profilesCommand,
  'install-service': installServiceCommand,
};

/** The whole CLI, with every side effect injected. Returns the exit code. */
export const runCli = async (
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> => {
  const [command, ...args] = argv;
  if (command === 'version' || command === '--version' || command === '-v') {
    out(deps, RUNNER_VERSION);
    return EXIT.ok;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    deps.stdout(USAGE);
    return EXIT.ok;
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
