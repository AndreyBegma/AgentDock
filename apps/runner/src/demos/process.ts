import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { parseProcessTable } from '../collectors/orchestrator/orchestrator';
import type { Exec } from '../detect/exec';
import type { Logger } from '../log';

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

/** pid → parent pid and command line. */
export type ProcessTable = ReturnType<typeof parseProcessTable>;

/** Lists the machine's processes; `null` when it cannot. */
export type ProcessLister = () => Promise<ProcessTable | null>;

/**
 * The parent pid in a `/proc/<pid>/stat` line, `pid (comm) state ppid …`.
 * `comm` may hold spaces and parentheses, so the fields start after the last
 * `)`.
 */
export const parseProcStat = (stat: string): number | null => {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const ppid = Number(
    stat
      .slice(close + 1)
      .trim()
      .split(/\s+/)[1],
  );
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
};

/** The command name in a `/proc/<pid>/stat` line, between the parentheses. */
const procComm = (stat: string): string =>
  stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));

const readProcess = async (procRoot: string, pid: number) => {
  try {
    const [stat, cmdline] = await Promise.all([
      readFile(join(procRoot, String(pid), 'stat'), 'utf8'),
      readFile(join(procRoot, String(pid), 'cmdline'), 'utf8'),
    ]);
    const ppid = parseProcStat(stat);
    if (ppid === null) return null;
    const words = cmdline.split('\0').filter((word) => word.length > 0);
    // A kernel thread or a zombie has no command line; `ps` shows `[comm]`.
    const args = words.length > 0 ? words.join(' ') : `[${procComm(stat)}]`;
    return { ppid, args };
  } catch {
    // The process exited between the listing and the read.
    return null;
  }
};

/**
 * C-369: the process table read from `/proc` (Linux), so a machine without
 * procps still sees DemoFlow's tree. `null` when `procRoot` cannot be listed.
 */
export const readProcTable = async (
  procRoot = '/proc',
): Promise<ProcessTable | null> => {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return null;
  }
  const pids = entries.filter((name) => /^\d+$/.test(name)).map(Number);
  const read = await Promise.all(
    pids.map(async (pid) => [pid, await readProcess(procRoot, pid)] as const),
  );
  const table: ProcessTable = new Map();
  for (const [pid, entry] of read) {
    if (entry) table.set(pid, entry);
  }
  return table.size > 0 ? table : null;
};

/** `/proc` on Linux, `ps -eo pid=,ppid=,args=` elsewhere or when it fails. */
export const createProcessLister =
  (exec: Exec, platform: NodeJS.Platform = process.platform): ProcessLister =>
  async () => {
    if (platform === 'linux') {
      const table = await readProcTable();
      if (table) return table;
    }
    const listed = await exec('ps', ['-eo', 'pid=,ppid=,args=']);
    return listed?.code === 0 ? parseProcessTable(listed.stdout) : null;
  };

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * C-369: every process DemoFlow starts, seen by listing the process table.
 * DemoFlow starts the app in a session of its own (`detached`), so killing
 * DemoFlow's process group would leave the app running; the runner keeps the
 * pid and command line of each descendant it has seen, so a process whose
 * parent already exited (reparented to init) is still found, and a reused
 * pid with another command line is never signalled. When the table cannot be
 * listed at all, `onUnlisted` is told and only the root's process group is
 * killed.
 */
export class ProcessTree {
  private readonly seen = new Map<number, string>();

  constructor(
    private readonly list: ProcessLister,
    readonly rootPid: number,
    private readonly onUnlisted: () => void = () => {},
  ) {}

  private async table() {
    const table = await this.list();
    if (!table) this.onUnlisted();
    return table;
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
  async alive(): Promise<number[] | null> {
    const table = await this.table();
    if (!table) return null;
    return [...this.seen].flatMap(([pid, args]) =>
      table.get(pid)?.args === args ? [pid] : [],
    );
  }

  /** Without a process table: the root's process group, which it leads. */
  private async killGroup(graceMs: number): Promise<number> {
    if (!groupAlive(this.rootPid)) return 0;
    signal(-this.rootPid, 'SIGTERM');
    await delay(graceMs);
    if (groupAlive(this.rootPid)) signal(-this.rootPid, 'SIGKILL');
    return 1;
  }

  /**
   * SIGTERM to every seen process and its process group, SIGKILL to what is
   * left after `graceMs`. Returns how many were still running at the start.
   */
  async kill(graceMs = KILL_GRACE_MS): Promise<number> {
    await this.poll();
    const running = await this.alive();
    if (running === null) return this.killGroup(graceMs);
    if (running.length === 0) return 0;
    for (const pid of running) {
      signal(-pid, 'SIGTERM');
      signal(pid, 'SIGTERM');
    }
    await delay(graceMs);
    for (const pid of (await this.alive()) ?? running) {
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
export const createDemoflowSpawn = (
  exec: Exec,
  config: {
    log?: Logger;
    list?: ProcessLister;
    pollMs?: number;
    killGraceMs?: number;
  } = {},
): DemoflowSpawn => {
  const list = config.list ?? createProcessLister(exec);
  let reported = false;
  const onUnlisted = () => {
    if (reported) return;
    reported = true;
    config.log?.warn(
      'cannot list processes (no /proc, no ps); a demo kills only its process group',
    );
  };
  return (binary, args, options) =>
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
      const tree = new ProcessTree(list, child.pid, onUnlisted);
      const kill = () => tree.kill(config.killGraceMs ?? KILL_GRACE_MS);
      const poll = setInterval(
        () => void tree.poll(),
        config.pollMs ?? TREE_POLL_MS,
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
};
