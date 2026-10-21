import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { TERSE_REGISTER } from '@nautelle/shared';
import type { Host } from '@nautelle/shared/protocol';
import { accessHeaders, accessOf } from './access';
import { runClaude } from './claude';
import type { Clock } from './clock';
import {
  ConfigError,
  hasPolicyBlock,
  isPaired,
  loadConfig,
  saveConfig,
} from './config';
import type { RunnerConnection, SocketFactory } from './connection';
import { runDaemon } from './daemon';
import { createExec, type Exec } from './detect/exec';
import { detectProfiles, withAuthentication } from './detect/profiles';
import { type Env, type Paths, resolvePaths } from './env';
import { runHook } from './hooks/run';
import { type LegacyReport, legacyReportLines } from './legacy';
import { runAway } from './local/away';
import { localSocketPath } from './local/paths';
import { type LocalCommandDeps, NotImplementedError } from './local/subcommand';
import { LockError } from './lock';
import { createLogger, errorMessage, type Logger, parseLogLevel } from './log';
import { runMcp } from './mcp';
import { otlpSettings } from './otlp';
import { PairingError, pair } from './pairing';
import { runPolicy } from './policy/cli';
import { nodeRealpath } from './policy/roots';
import { reportUpgrade } from './policy/upgrade';
import { normalizeServer, ServerUrlError } from './server-url';
import {
  EXIT,
  LEGACY_SERVICE_NAME,
  launchAgentPlist,
  SERVICE_NAME,
  serviceUnit,
} from './service';
import { setupClaude } from './setup/claude';
import { Spool } from './spool';
import {
  clearStopStatus,
  readStopStatus,
  stopMessage,
  writeStopStatus,
} from './stop-status';
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
  /** A yes/no question on the terminal; Bun's `confirm` by default. */
  confirm?: (question: string) => boolean;
  /** The user id, for `launchctl`; `process.getuid()` by default. */
  uid?: number;
  /**
   * ADR-0073: what `main.ts` adopted and moved from the `agentdock` names
   * before the CLI started, logged once by the commands a person runs.
   */
  legacy?: LegacyReport;
}

const USAGE = `Usage: nautelle-runner <command>

Commands:
  pair --server <url> --code <XXXX-XXXX> [--no-detect] [--allow-root <dir>]… [--insecure]
       [--access-client-id <id> (--access-client-secret <secret> | --access-client-secret-stdin)]
                                           pair this machine with a Nautelle server
                                           (detects runtime profiles unless --no-detect;
                                           --allow-root lets projects under <dir> be watched;
                                           --insecure allows plain http to a host that is not
                                           loopback — cleartext, at your own risk;
                                           --access-client-* store a Cloudflare Access
                                           service token, sent on pairing and every connect;
                                           the secret may also come from
                                           NAUTELLE_ACCESS_CLIENT_SECRET)
  run                                      run the daemon in the foreground
  status                                   show config, connectivity and spool
  profiles [--detect [--write]]            list runtime profiles, or detect them
  install-service                          write the systemd user unit (Linux)
                                           or the launchd agent (macOS)
  setup claude [--profile <key>] [--no-telemetry] [--dry-run] [--uninstall]
                                           install the nautelle Claude Code plugin
                                           and point telemetry at this runner
  away on|off                              route permission prompts to Nautelle
                                           while you are away
  policy show|set|allow-root|deny-root     the runner-local security policy; only
                                           this command changes it (\`policy\` for help)
  version                                  print the version and the target

Used by the nautelle Claude Code plugin:
  hook <name>                              report a Claude Code hook (JSON on stdin)
  mcp                                      the nautelle MCP server (stdio)
  claude [-- <args>]                       run claude in a tmux session Nautelle
                                           can attach to

Used by the runner's launches (Token saver):
  filter -- <command> [args…]              run a command and compress its output;
                                           NAUTELLE_RAW=1 leaves it unfiltered
  filter-hook                              the PreToolUse hook that routes Bash
                                           calls through filter (JSON on stdin)
  read-hook                                the Read hook that refuses a whole read
                                           of a big file and a repeated read once
                                           (JSON on stdin)
  tool-hook                                the PostToolUse hook that cuts a large
                                           MCP, Grep or WebFetch result (JSON on
                                           stdin)
  register                                print the terse working register
`;

class UsageError extends Error {}

const insecureWarning = (server: string): string =>
  `WARNING: ${server} is plain http (pair --insecure). The runner token, prompts and session content travel in cleartext; anyone on the network path can read or rewrite them. Use https://.`;

interface Context {
  deps: CliDeps;
  paths: Paths;
  log: Logger;
  args: string[];
}

const out = (deps: CliDeps, line: string) => deps.stdout(`${line}\n`);

type FlagOptions = Record<
  string,
  { type: 'string' | 'boolean'; multiple?: boolean }
>;

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
    'allow-root': allowRoot = [],
    insecure = false,
    'access-client-id': accessClientId,
    'access-client-secret': secretFlag,
    'access-client-secret-stdin': secretStdin,
  } = flags(args, {
    server: { type: 'string' },
    code: { type: 'string' },
    'no-detect': { type: 'boolean' },
    'allow-root': { type: 'string', multiple: true },
    insecure: { type: 'boolean' },
    'access-client-id': { type: 'string' },
    'access-client-secret': { type: 'string' },
    'access-client-secret-stdin': { type: 'boolean' },
  });
  if (!server || !code) throw new UsageError('pair needs --server and --code');
  if (secretFlag !== undefined && secretStdin) {
    throw new UsageError(
      'use either --access-client-secret or --access-client-secret-stdin',
    );
  }
  const accessSecret = secretStdin
    ? (
        await new Response((deps.stdin ?? (() => Bun.stdin.stream()))()).text()
      ).trim()
    : (secretFlag ?? deps.env.NAUTELLE_ACCESS_CLIENT_SECRET);
  if (accessSecret) log.addSecret(accessSecret);
  if (Boolean(accessClientId) !== Boolean(accessSecret)) {
    throw new UsageError(
      'a Cloudflare Access service token needs both --access-client-id and the secret',
    );
  }
  const access =
    accessClientId && accessSecret
      ? { clientId: accessClientId, clientSecret: accessSecret }
      : undefined;
  const origin = normalizeServer(server, insecure);
  const cleartext = insecure && origin.startsWith('http:');
  const config = loadConfig(paths.configFile);
  // ADR-0047: resolved before pairing, so a typo costs no pairing code.
  const allowed = allowRoot.map((dir) => {
    const real = nodeRealpath(resolve(deps.cwd ?? process.cwd(), dir));
    if (real === null)
      throw new UsageError(`--allow-root ${dir} does not exist`);
    return real;
  });

  const paired = await pair({
    server: origin,
    insecure,
    code,
    access,
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
    // Only `pair` sets it (D-06): a re-pair over https clears it.
    insecureServer: cleartext ? true : undefined,
    // Only `pair` sets it: a re-pair without a token clears it.
    accessClientId: access?.clientId,
    accessClientSecret: access?.clientSecret,
    runnerId: paired.runnerId,
    token: paired.token,
    profiles: detected ?? config.profiles,
    policy: {
      ...config.policy,
      allowedRoots: [...new Set([...config.policy.allowedRoots, ...allowed])],
    },
    // Sessions are ingested from pairing on, unless a backfill asks (D11).
    sessions: {
      ...config.sessions,
      ingestSince:
        config.sessions.ingestSince ?? new Date(deps.clock.now()).toISOString(),
    },
  });
  log.info('paired', { runnerId: paired.runnerId, server: origin });
  if (cleartext) out(deps, insecureWarning(origin));
  out(
    deps,
    `Paired as ${paired.runnerId}. Config written to ${paths.configFile}`,
  );
  const roots = [...new Set([...config.policy.allowedRoots, ...allowed])];
  out(
    deps,
    roots.length > 0
      ? `Projects may be watched under: ${roots.join(', ')}`
      : 'No project root is allowed yet: run `nautelle-runner policy allow-root <dir>` before connecting a project.',
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
      'Not paired. Run `nautelle-runner pair --server <url> --code <code>` first.\n',
    );
    return EXIT.failure;
  }
  log.addSecret(config.token);
  if (config.accessClientSecret) log.addSecret(config.accessClientSecret);
  try {
    normalizeServer(config.server, config.insecureServer);
  } catch (error) {
    deps.stderr(`${errorMessage(error)}\n`);
    return EXIT.failure;
  }
  if (config.insecureServer) {
    const warning = insecureWarning(config.server);
    deps.stderr(`${warning}\n`);
    log.warn(warning);
  }
  // #691: a config from before 0.13 has no policy, so nothing is watched.
  if (!hasPolicyBlock(paths.configFile)) {
    reportUpgrade(config.projects, log, deps.stderr);
  }
  // ADR-0073: the unit or agent from before the rename is still installed.
  for (const file of [paths.legacy.serviceFile, paths.legacy.launchAgentFile]) {
    if (existsSync(file)) {
      log.warn(
        `${file} is the service from before the rename to Nautelle: run \`nautelle-runner install-service\` to replace it (ADR-0073)`,
      );
    }
  }
  if (config.profiles.length === 0) {
    log.warn(
      'no runtime profiles configured; nothing can be launched. Run `nautelle-runner profiles --detect --write`',
    );
  }
  clearStopStatus(paths.stopStatusFile);
  const reason = await runDaemon({
    config,
    configFile: paths.configFile,
    localSocket: socketPathOf(deps, paths),
    home: paths.home,
    spoolDir: paths.spoolDir,
    offsetsFile: paths.offsetsFile,
    host: deps.host,
    exec: deps.exec ?? createExec(deps.env),
    env: deps.env,
    clock: deps.clock,
    log,
    createSocket: deps.createSocket,
    random: deps.random,
    signal: deps.signal,
    onStart: deps.onStart,
  });
  if (reason.kind !== 'terminal') return EXIT.ok;
  // The process is about to end and the unit will not restart it: leave the
  // why where `status` finds it (C-108).
  const stopped = {
    code: reason.code,
    reason: reason.reason,
    at: new Date(deps.clock.now()).toISOString(),
  };
  try {
    writeStopStatus(paths.stopStatusFile, stopped);
  } catch (error) {
    log.error('cannot write the stop status', {
      file: paths.stopStatusFile,
      error: errorMessage(error),
    });
  }
  log.error(`stopped: ${stopMessage(stopped)}`, { code: reason.code });
  return EXIT.terminalClose;
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
  if (config.accessClientSecret) log.addSecret(config.accessClientSecret);
  const spool = Spool.inspect(paths.spoolDir);
  out(deps, `config:   ${paths.configFile}`);
  out(
    deps,
    `paired:   ${isPaired(config) ? `yes, as ${config.runnerId}` : 'no'}`,
  );
  out(deps, `server:   ${config.server ?? '-'}`);
  if (config.insecureServer && config.server) {
    out(deps, insecureWarning(config.server));
  }
  out(deps, `profiles: ${config.profiles.length}`);
  if (accessOf(config)) out(deps, 'access token: set');
  const stopped = readStopStatus(paths.stopStatusFile);
  if (stopped) out(deps, `stopped:  ${stopMessage(stopped)}`);
  out(
    deps,
    `spool:    ${spool.segments} segment(s), ${spool.bytes} bytes, last seq ${spool.lastSeq}, acked ${spool.ackedSeq}`,
  );
  if (config.server) {
    try {
      const response = await deps.fetch(config.server, {
        method: 'GET',
        headers: accessHeaders(accessOf(config)),
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
        'No profiles configured. Try `nautelle-runner profiles --detect`.\n',
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
    // Only the policy CLI writes a policy: a pre-0.13 file keeps none (#691).
    saveConfig(
      paths.configFile,
      { ...config, profiles: proposed },
      { withoutPolicy: !hasPolicyBlock(paths.configFile) },
    );
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
  const exec = deps.exec ?? createExec(deps.env);
  if (deps.host.os === 'darwin') {
    mkdirSync(dirname(paths.launchAgentFile), { recursive: true });
    mkdirSync(dirname(paths.launchAgentLog), { recursive: true });
    writeFileSync(
      paths.launchAgentFile,
      launchAgentPlist(deps.execStart, paths.launchAgentLog, deps.env.PATH),
      { mode: 0o644 },
    );
    out(deps, `Wrote ${paths.launchAgentFile}`);
    // ADR-0073: the agent before the rename is unloaded and replaced.
    if (existsSync(paths.legacy.launchAgentFile)) {
      const domain = `gui/${deps.uid ?? process.getuid?.() ?? 0}`;
      await exec('launchctl', [
        'bootout',
        domain,
        paths.legacy.launchAgentFile,
      ]);
      rmSync(paths.legacy.launchAgentFile, { force: true });
      out(deps, `Removed ${paths.legacy.launchAgentFile}`);
      const loaded = await exec('launchctl', [
        'bootstrap',
        domain,
        paths.launchAgentFile,
      ]);
      if (loaded?.code === 0) {
        out(deps, `Loaded ${paths.launchAgentFile} in its place`);
        out(deps, `Logs: ${paths.launchAgentLog}`);
        return EXIT.ok;
      }
    }
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
  // ADR-0073: the unit before the rename is stopped and replaced, so the
  // runner is back under its new name without a second step.
  if (existsSync(paths.legacy.serviceFile)) {
    await exec('systemctl', [
      '--user',
      'disable',
      '--now',
      LEGACY_SERVICE_NAME,
    ]);
    rmSync(paths.legacy.serviceFile, { force: true });
    out(deps, `Removed ${paths.legacy.serviceFile}`);
    const reloaded = await exec('systemctl', ['--user', 'daemon-reload']);
    const enabled =
      reloaded?.code === 0
        ? await exec('systemctl', ['--user', 'enable', '--now', SERVICE_NAME])
        : null;
    if (enabled?.code === 0) {
      out(deps, `Enabled and started ${SERVICE_NAME} in its place`);
      return EXIT.ok;
    }
  }
  out(
    deps,
    `Enable it with: systemctl --user daemon-reload && systemctl --user enable --now ${SERVICE_NAME}`,
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
  policy: async ({ deps, paths, args }) =>
    runPolicy(args, {
      configFile: paths.configFile,
      cwd: deps.cwd ?? process.cwd(),
      realpath: nodeRealpath,
      stdout: deps.stdout,
      stderr: deps.stderr,
      confirm: deps.confirm ?? ((question) => confirm(question)),
    }),
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
  // #663 D3: the one terse register; the plugin reads this output.
  if (command === 'register') {
    out(deps, TERSE_REGISTER);
    return EXIT.ok;
  }
  // `main.ts` serves these before loading the CLI (#445 D3); this path is for
  // callers of `runCli` itself.
  if (
    command === 'filter' ||
    command === 'filter-hook' ||
    command === 'read-hook' ||
    command === 'tool-hook'
  ) {
    const { runFilterCommand } = await import('./filter/main');
    // One decoder per stream: a character may span two chunks.
    const writer = (write: (text: string) => void) => {
      const decoder = new TextDecoder();
      return (bytes: Uint8Array | string) =>
        write(
          typeof bytes === 'string'
            ? bytes
            : decoder.decode(bytes, { stream: true }),
        );
    };
    const stdin = deps.stdin ?? (() => Bun.stdin.stream());
    return runFilterCommand(argv, {
      env: deps.env,
      stdout: writer(deps.stdout),
      stderr: writer(deps.stderr),
      stdin: () => new Response(stdin()).text(),
      flush: async () => {},
    });
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
  // ADR-0073: once per start; `mcp` and `claude` stay quiet, as `hook` does,
  // because their output belongs to Claude Code and the terminal.
  if (deps.legacy && command !== 'mcp' && command !== 'claude') {
    for (const line of legacyReportLines(deps.legacy)) log.warn(line);
  }
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
