import { mkdirSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type Capabilities,
  type Host,
  PROTOCOL_VERSION,
} from '@agentdock/shared/protocol';
import { adapters, SessionWatcher } from './adapters';
import { resolveIngestSince } from './adapters/ingest-since';
import { Backoff } from './backoff';
import type { Clock } from './clock';
import { CollectorRegistry, collectors } from './collectors';
import { createDispatcher } from './commands/dispatcher';
import { createHandlers } from './commands/handlers';
import { loadConfig, type PairedConfig, saveConfig } from './config';
import {
  type HeartbeatPayload,
  RunnerConnection,
  type SocketFactory,
  type StopReason,
} from './connection';
import {
  detectCapabilities,
  extractVersion,
  ptyAvailable,
  terminalCapability,
  terminalUnsupported,
} from './detect/capabilities';
import type { Exec } from './detect/exec';
import { acquireLock } from './lock';
import { errorMessage, type Logger } from './log';
import { otlpSettings, startOtlpReceiver } from './otlp';
import { PaneStreamer } from './pane';
import { WatchList } from './projects/watch-list';
import {
  createSkillHandlers,
  RunLogStreamer,
  SkillRunExecutor,
} from './skills';
import { Spool } from './spool';
import { bunSpawnPty, type SpawnPty, TerminalManager } from './terminal';
import { RUNNER_VERSION } from './version';

export interface DaemonOptions {
  config: PairedConfig;
  /** Where `config` was read from; the watch list is cached back into it. */
  configFile: string;
  home: string;
  spoolDir: string;
  /** Transcript read positions (spec 12 D5). */
  offsetsFile: string;
  host: Host;
  exec: Exec;
  clock: Clock;
  log: Logger;
  createSocket?: SocketFactory;
  random?: () => number;
  /** Spawns the PTY of a terminal attach (spec 29); Bun's own by default. */
  spawnPty?: SpawnPty;
  /** Skill runs' directories (spec 24 D7); `<state>/agentdock/runs` beside the spool by default. */
  runsDir?: string;
  /** The argv that starts this runner; a skill run's session appends `exec-run <runDir>`. */
  selfCommand?: readonly string[];
  /** The skills.sh catalog is fetched with it; the global `fetch` by default. */
  fetch?: typeof fetch;
  /** Aborting it stops the daemon cleanly. */
  signal?: AbortSignal;
  /** Called once the connection exists — tests reach it to emit events. */
  onStart?: (connection: RunnerConnection) => void;
}

/** This runner as an argv: the compiled binary, or bun with the entry script. */
export const defaultSelfCommand = (): string[] =>
  Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, Bun.main];

/** Counts tmux sessions; no tmux or no server means zero. */
const countTmuxSessions = async (exec: Exec): Promise<number> => {
  const result = await exec('tmux', ['list-sessions', '-F', '#{session_name}']);
  if (!result || result.code !== 0) return 0;
  return result.stdout.split('\n').filter((l) => l.trim().length > 0).length;
};

/** `agentdock-runner run`: lock the spool, detect, connect, run until stopped. */
export const runDaemon = async (
  options: DaemonOptions,
): Promise<StopReason> => {
  const { config, home, exec, clock, log } = options;
  mkdirSync(options.spoolDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(join(options.spoolDir, 'runner.lock'));
  try {
    const spool = Spool.open({
      dir: options.spoolDir,
      log,
      now: () => new Date(clock.now()),
    });
    log.info('spool opened', { ...spool.stats() });

    const redetect = async (): Promise<Capabilities> => {
      const capabilities = await detectCapabilities({
        exec,
        home,
        // The receiver's port as bound, not as configured (spec 13).
        config: { profiles: config.profiles, otlp: otlpCapability() },
      });
      const terminal = terminalCapability({
        tmux: capabilities.tmux,
        disabledCommands: config.disabledCommands,
        pty: ptyAvailable(),
      });
      log.info('capabilities detected', {
        claude: capabilities.runtimes.claude?.version ?? null,
        codex: capabilities.runtimes.codex?.version ?? null,
        profiles: capabilities.profiles.length,
        terminal,
      });
      return { ...capabilities, terminal };
    };

    // Collectors emit through the connection, which exists only below.
    let connection: RunnerConnection | null = null;
    const registry = new CollectorRegistry({
      factories: collectors,
      emit: (event) => connection?.emit(event),
      log,
      context: { exec, clock, fleet: config.fleet },
    });
    const watchList = new WatchList({
      initial: config.projects,
      registry,
      persist: (projects) =>
        saveConfig(options.configFile, {
          ...loadConfig(options.configFile),
          projects,
        }),
      log,
    });

    // Agent sessions (spec 12): one watcher over every runtime profile. A
    // profile holds the sessions of every directory, so it is not a collector.
    const sessions = config.sessions.enabled
      ? new SessionWatcher({
          adapters,
          profiles: config.profiles,
          home,
          offsetsFile: options.offsetsFile,
          ingestSince: resolveIngestSince(
            config,
            options.configFile,
            clock,
            log,
          ),
          emit: (event) => connection?.emit(event),
          clock,
          log,
        })
      : null;

    // Interactive attaches (spec 29): bytes go out through the connection,
    // which exists only below; `reset` ends every attach when it drops.
    const terminal = new TerminalManager({
      exec,
      clock,
      log,
      watchedProjects: () => watchList.current,
      send: (message) => connection?.sendMessage(message) ?? false,
      spawn: options.spawnPty ?? bunSpawnPty(process.env),
      unsupported: async () => {
        const tmux = await exec('tmux', ['-V']);
        return terminalUnsupported(
          tmux && tmux.code === 0 ? extractVersion(tmux.stdout) : null,
          ptyAvailable(),
        );
      },
    });

    // Skills (spec 24): runs report through the connection, which exists only
    // below; the executor starts once it does.
    const skillsDeps = {
      exec,
      clock,
      home,
      profiles: () => config.profiles,
      watchedProjects: () => watchList.current,
      fetch: options.fetch ?? fetch,
    };
    const runs = new SkillRunExecutor({
      deps: skillsDeps,
      runsDir: options.runsDir ?? join(dirname(options.spoolDir), 'runs'),
      selfCommand: options.selfCommand ?? defaultSelfCommand(),
      maxConcurrentRuns: config.skills.maxConcurrentRuns,
      maxTimeoutSec: config.skills.maxTimeoutSec,
      emit: (event) => connection?.emit(event),
      log,
      otlpPort: () => otlp?.port ?? null,
    });
    const runLog = new RunLogStreamer({
      runs,
      send: (message) => connection?.sendMessage(message) ?? false,
      clock,
      log,
    });

    const dispatch = createDispatcher({
      handlers: createHandlers({
        clock,
        runnerVersion: RUNNER_VERSION,
        host: options.host,
        detectCapabilities: redetect,
        exec,
        watchedProjects: () => watchList.current,
        profiles: () => config.profiles,
        backfillSessions: sessions
          ? (scope) => sessions.backfill(scope)
          : undefined,
        terminal,
        skills: createSkillHandlers(skillsDeps, runs),
      }),
      disabledCommands: config.disabledCommands,
      clock,
      log,
    });

    // Live pane (spec 18): frames go out through the connection, which exists
    // only below; with the socket down they are dropped and `reset` ends them.
    const pane = new PaneStreamer({
      exec,
      clock,
      watchedProjects: () => watchList.current,
      send: (message) => connection?.sendMessage(message) ?? false,
      log,
    });

    const heartbeat = async (): Promise<HeartbeatPayload> => {
      const [one, five, fifteen] = loadavg();
      return {
        load: [one, five, fifteen],
        tmuxSessions: await countTmuxSessions(exec),
        collectors: {},
      };
    };

    const live = new RunnerConnection({
      server: config.server,
      token: config.token,
      spool,
      clock,
      backoff: new Backoff({ random: options.random }),
      log,
      // Each (re)connect reports the machine as it is now.
      hello: async () => ({
        runnerVersion: RUNNER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        ...options.host,
        capabilities: await redetect(),
      }),
      heartbeat,
      dispatch,
      pane,
      terminal,
      runLog,
      onConfig: (server) => {
        sessions?.setProjects(server.projects).catch(() => {});
        watchList.apply(server.projects).catch((error) => {
          log.error('cannot apply the watch list', {
            error: errorMessage(error),
          });
        });
      },
      createSocket: options.createSocket,
    });
    connection = live;

    // OTLP receiver (spec 13 D11): sessions with telemetry on report each
    // request live, into the spool like every other event. Started before
    // `hello`, which reports its port.
    const otlp = startOtlpReceiver({
      settings: otlpSettings(config.otlp),
      emit: (event) => live.emit(event),
      projects: () => watchList.current,
      exec,
      clock,
      log,
    });
    const otlpCapability = (): Capabilities['otlp'] =>
      otlp?.port ? { grpc: null, http: otlp.port } : null;

    const onAbort = () => live.stop();
    if (options.signal?.aborted) live.stop();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    await watchList.start();
    // Runs a previous runner left are picked up; their events go to the spool.
    await runs.start().catch((error) => {
      log.error('skills: cannot resume runs', { error: errorMessage(error) });
    });
    // Not awaited: a first scan of a large profile must not delay connecting.
    sessions?.start(watchList.current).catch((error) => {
      log.error('sessions: cannot start', { error: errorMessage(error) });
    });
    live.start();
    options.onStart?.(live);
    const reason = await live.done;
    options.signal?.removeEventListener('abort', onAbort);
    pane.stop();
    runLog.stop();
    // Sessions run on in tmux; the next start resumes watching them.
    runs.stop();
    terminal.stop();
    await registry.stop();
    await sessions?.stop();
    await otlp?.stop();
    return reason;
  } finally {
    release();
  }
};
