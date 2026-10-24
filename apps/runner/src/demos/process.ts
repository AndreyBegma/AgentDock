import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { parseProcessTable } from '../collectors/orchestrator/orchestrator';
import type { Exec } from '../detect/exec';

/** How long a port probe waits for a connection. */
const PROBE_TIMEOUT_MS = 1_000;

const answers = (host: string, port: number): Promise<boolean> =>
  new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (open: boolean) => {
      socket.destroy();
      done(open);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

/**
 * Whether something already listens on `port` of this machine, on either
 * loopback: DemoFlow would record that instead of the card's app.
 */
export const portInUse = async (port: number): Promise<boolean> => {
  const probes = await Promise.all([
    answers('127.0.0.1', port),
    answers('::1', port),
  ]);
  return probes.some(Boolean);
};

/** A port free on 127.0.0.1 now, chosen by the kernel. */
export const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? done(port) : fail(new Error('no port'))));
    });
  });

/** What the runner keeps of a finished `demoflow run`. */
export interface DemoflowExit {
  /** `null` when a signal ended it. */
  code: number | null;
  stdout: string;
  /** The last `STDERR_TAIL` characters. */
  stderr: string;
  timedOut: boolean;
}

export interface DemoflowSpawnOptions {
  cwd: string;
  /** The whole environment of the process: the runner's, `PORT`, the secrets. */
  env: Record<string, string>;
  timeoutMs: number;
}

/** Runs DemoFlow; tests replace it. */
export type DemoflowSpawn = (
  binary: string,
  args: readonly string[],
  options: DemoflowSpawnOptions,
) => Promise<DemoflowExit>;

/** stdout is one summary line; more than this is not DemoFlow. */
const STDOUT_MAX = 1024 * 1024;
const STDERR_TAIL = 4096;
/** How often the process tree is listed while DemoFlow runs. */
export const TREE_POLL_MS = 2_000;
/** From SIGTERM to SIGKILL. */
export const KILL_GRACE_MS = 5_000;
/** From DemoFlow's exit to reading its output without the pipes closing. */
const PIPE_DRAIN_MS = 2_000;

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(pid, name);
  } catch {
    // Gone already, or not ours.
  }
};

/**
 * C-369: every process DemoFlow starts, seen by listing the process table.
 * DemoFlow starts the app in a session of its own (`detached`), so killing
 * DemoFlow's process group would leave the app running; the runner keeps the
 * pid and command line of each descendant it has seen, so a process whose
 * parent already exited (reparented to init) is still found, and a reused
 * pid with another command line is never signalled.
 */
export class ProcessTree {
  private readonly seen = new Map<number, string>();

  constructor(
    private readonly exec: Exec,
    readonly rootPid: number,
  ) {}

  private async table() {
    const listed = await this.exec('ps', ['-eo', 'pid=,ppid=,args=']);
    return listed?.code === 0 ? parseProcessTable(listed.stdout) : null;
  }

  /** Adds the root's live descendants to what it has seen. */
  async poll(): Promise<void> {
    const table = await this.table();
    if (!table) return;
    const known = new Set([this.rootPid, ...this.seen.keys()]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, entry] of table) {
        if (known.has(entry.ppid) && !known.has(pid)) {
          known.add(pid);
          this.seen.set(pid, entry.args);
          grew = true;
        }
      }
    }
    const root = table.get(this.rootPid);
    if (root && !this.seen.has(this.rootPid)) {
      this.seen.set(this.rootPid, root.args);
    }
  }

  /** Seen processes still running with the command line they had. */
  async alive(): Promise<number[]> {
    const table = await this.table();
    if (!table) return [];
    return [...this.seen].flatMap(([pid, args]) =>
      table.get(pid)?.args === args ? [pid] : [],
    );
  }

  /**
   * SIGTERM to every seen process and its process group, SIGKILL to what is
   * left after `graceMs`. Returns how many were still running at the start.
   */
  async kill(graceMs = KILL_GRACE_MS): Promise<number> {
    await this.poll();
    const running = await this.alive();
    if (running.length === 0) return 0;
    for (const pid of running) {
      signal(-pid, 'SIGTERM');
      signal(pid, 'SIGTERM');
    }
    await delay(graceMs);
    for (const pid of await this.alive()) {
      signal(-pid, 'SIGKILL');
      signal(pid, 'SIGKILL');
    }
    return running.length;
  }
}

/**
 * C-369: `demoflow run` in its own process group, with the environment it is
 * given and no other; stdin closed. Past `timeoutMs` the whole tree is
 * killed; when it ends on its own, whatever it left running is killed too.
 * Output is kept in memory only, never logged.
 */
export const createDemoflowSpawn =
  (
    exec: Exec,
    timing: { pollMs?: number; killGraceMs?: number } = {},
  ): DemoflowSpawn =>
  (binary, args, options) =>
    new Promise((done, fail) => {
      const child = spawn(binary, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < STDOUT_MAX) stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL);
      });
      child.once('error', fail);
      if (child.pid === undefined) return;
      const tree = new ProcessTree(exec, child.pid);
      const kill = () => tree.kill(timing.killGraceMs ?? KILL_GRACE_MS);
      const poll = setInterval(
        () => void tree.poll(),
        timing.pollMs ?? TREE_POLL_MS,
      );
      void tree.poll();
      const timer = setTimeout(() => {
        timedOut = true;
        void kill();
      }, options.timeoutMs);
      let ended = false;
      const end = (code: number | null) => {
        if (ended) return;
        ended = true;
        clearInterval(poll);
        clearTimeout(timer);
        void kill().finally(() => done({ code, stdout, stderr, timedOut }));
      };
      child.once('close', end);
      // A process that outlives DemoFlow may hold its pipes open; its output
      // is complete once DemoFlow has exited and the pipes had a moment.
      child.once('exit', (code) => {
        setTimeout(() => end(code), PIPE_DRAIN_MS);
      });
    });
