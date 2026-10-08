import { mkdirSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import {
  type Capabilities,
  type Host,
  PROTOCOL_VERSION,
} from '@agentdock/shared/protocol';
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
import { detectCapabilities } from './detect/capabilities';
import type { Exec } from './detect/exec';
import { acquireLock } from './lock';
import { errorMessage, type Logger } from './log';
import { WatchList } from './projects/watch-list';
import { Spool } from './spool';
import { RUNNER_VERSION } from './version';

export interface DaemonOptions {
  config: PairedConfig;
  /** Where `config` was read from; the watch list is cached back into it. */
  configFile: string;
  home: string;
  spoolDir: string;
  host: Host;
  exec: Exec;
  clock: Clock;
  log: Logger;
  createSocket?: SocketFactory;
  random?: () => number;
  /** Aborting it stops the daemon cleanly. */
  signal?: AbortSignal;
  /** Called once the connection exists — tests reach it to emit events. */
  onStart?: (connection: RunnerConnection) => void;
}

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
      const capabilities = await detectCapabilities({ exec, home, config });
      log.info('capabilities detected', {
        claude: capabilities.runtimes.claude?.version ?? null,
        codex: capabilities.runtimes.codex?.version ?? null,
        profiles: capabilities.profiles.length,
      });
      return capabilities;
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

    const dispatch = createDispatcher({
      handlers: createHandlers({
        clock,
        runnerVersion: RUNNER_VERSION,
        host: options.host,
        detectCapabilities: redetect,
        exec,
        watchedProjects: () => watchList.current,
      }),
      disabledCommands: config.disabledCommands,
      clock,
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
      onConfig: (server) => {
        watchList.apply(server.projects).catch((error) => {
          log.error('cannot apply the watch list', {
            error: errorMessage(error),
          });
        });
      },
      createSocket: options.createSocket,
    });
    connection = live;

    const onAbort = () => live.stop();
    if (options.signal?.aborted) live.stop();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    await watchList.start();
    live.start();
    options.onStart?.(live);
    const reason = await live.done;
    options.signal?.removeEventListener('abort', onAbort);
    await registry.stop();
    return reason;
  } finally {
    release();
  }
};
