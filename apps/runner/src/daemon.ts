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
import { createDispatcher } from './commands/dispatcher';
import { createHandlers } from './commands/handlers';
import type { PairedConfig } from './config';
import {
  type HeartbeatPayload,
  RunnerConnection,
  type SocketFactory,
  type StopReason,
} from './connection';
import { detectCapabilities } from './detect/capabilities';
import type { Exec } from './detect/exec';
import { acquireLock } from './lock';
import type { Logger } from './log';
import { Spool } from './spool';
import { RUNNER_VERSION } from './version';

export interface DaemonOptions {
  config: PairedConfig;
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

    const dispatch = createDispatcher({
      handlers: createHandlers({
        clock,
        runnerVersion: RUNNER_VERSION,
        host: options.host,
        detectCapabilities: redetect,
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

    const connection = new RunnerConnection({
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
      createSocket: options.createSocket,
    });

    const onAbort = () => connection.stop();
    if (options.signal?.aborted) connection.stop();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    connection.start();
    options.onStart?.(connection);
    const reason = await connection.done;
    options.signal?.removeEventListener('abort', onAbort);
    return reason;
  } finally {
    release();
  }
};
