import type { Exec } from '../detect/exec';
import type { Env } from '../env';

/**
 * What `cli.ts` hands the plugin-facing subcommands — `hook`, `away`, `mcp`
 * and `claude` (spec 201). Each runs in a short-lived process next to a
 * Claude Code session and reaches the daemon through `socketPath` only.
 */
export interface LocalCommandDeps {
  env: Env;
  /** `process.platform`: `linux` or `darwin`. */
  os: string;
  /** The daemon's socket (D5), derived like the daemon derives it. */
  socketPath: string;
  /** The process's working directory. */
  cwd: string;
  /** The parent pid: the `claude` process, or the shell it ran the hook in. */
  ppid: number;
  /** The process's stdin, read once. */
  stdin: () => ReadableStream<Uint8Array>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exec: Exec;
}

/** A wave-3 subcommand that is not built yet. */
export class NotImplementedError extends Error {
  readonly code = 'not_implemented';

  constructor(command: string) {
    super(`agentdock-runner ${command} is not implemented yet`);
  }
}
