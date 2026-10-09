import type { TerminalMode } from '@agentdock/shared/protocol';
import type { Env } from '../env';

/** What the attach manager needs from a spawned `tmux attach` client. */
export interface PtyProcess {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Signals the `tmux attach` client — never the session it is attached to. */
  kill(signal: 'SIGHUP' | 'SIGKILL'): void;
  /** Resolves once the client process has exited. */
  readonly exited: Promise<unknown>;
  /** Releases the PTY; harmless when already closed. */
  close(): void;
}

export interface PtySpawnOptions {
  /** `attachArgv`'s output; `argv[0]` is `tmux`. */
  argv: readonly string[];
  cols: number;
  rows: number;
  onData: (bytes: Uint8Array) => void;
}

/** Spawns a PTY; tests inject a fake one. Throws when the client cannot start. */
export type SpawnPty = (options: PtySpawnOptions) => PtyProcess;

/** The terminal type the PTY announces (D3). */
export const TERMINAL_NAME = 'xterm-256color';

/**
 * D3/D4's command, one argv element per value — never a shell string. `read`
 * attaches read-only and leaves the agent's window size alone; `write` is the
 * plain `attach-session`. The `=` makes the target an exact match: without it
 * tmux falls back to a prefix, and `cs-i4` would attach to `cs-i42`.
 */
export const attachArgv = (
  tmuxServer: readonly string[],
  session: string,
  mode: TerminalMode,
): string[] => [
  'tmux',
  ...tmuxServer,
  'attach-session',
  ...(mode === 'read' ? ['-r', '-f', 'ignore-size'] : []),
  '-t',
  `=${session}`,
];

/**
 * The environment of the attach client: the runner's own, without the
 * variables that would make tmux think it is nested in another client.
 */
export const attachEnv = (env: Env): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === 'TMUX' || key === 'TMUX_PANE') continue;
    out[key] = value;
  }
  out.TERM = TERMINAL_NAME;
  return out;
};

/** Bun's PTY (`Bun.spawn({ terminal })`, Bun ≥ 1.3.5, POSIX only). */
export const bunSpawnPty =
  (env: Env): SpawnPty =>
  ({ argv, cols, rows, onData }) => {
    const [binary, ...args] = argv;
    const path = binary ? Bun.which(binary, { PATH: env.PATH ?? '' }) : null;
    if (!path) throw new Error(`${binary} is not on PATH`);
    const proc = Bun.spawn([path, ...args], {
      env: attachEnv(env),
      terminal: {
        cols,
        rows,
        name: TERMINAL_NAME,
        data: (_terminal, data) => onData(data),
      },
    });
    const terminal = proc.terminal;
    if (!terminal) {
      proc.kill('SIGHUP');
      throw new Error('the PTY did not open');
    }
    return {
      write: (bytes) => {
        if (!terminal.closed) terminal.write(bytes);
      },
      resize: (c, r) => {
        if (!terminal.closed) terminal.resize(c, r);
      },
      kill: (signal) => {
        if (proc.exitCode === null && proc.signalCode === null)
          proc.kill(signal);
      },
      exited: proc.exited,
      close: () => {
        if (!terminal.closed) terminal.close();
      },
    };
  };
