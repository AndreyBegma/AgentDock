import { homedir, platform } from 'node:os';
import { runFilter } from './engine';
import { ALL_FILTERS } from './families';
import { runFilterHook } from './hook';
import type { Filter } from './types';

/**
 * The filter's own entry (#445 D3). `main.ts` imports it before anything
 * else, so `filter` and `filter-hook` start without loading the daemon's
 * module graph — they sit on every Bash call of every agent, and the budget
 * is 50 ms (p95) per command.
 */

export const FILTER_COMMANDS = new Set(['filter', 'filter-hook']);

/** This runner as an argv: the compiled binary, or bun with the entry script. */
const selfCommand = (): string[] =>
  Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, Bun.main];

export interface FilterIo {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (bytes: Uint8Array | string) => void;
  stderr: (bytes: Uint8Array | string) => void;
  stdin: () => Promise<string>;
  /** Resolves once everything written to stdout is out. */
  flush: () => Promise<void>;
  /** Calls `handler` once stdout can take nothing more. */
  onStdoutClosed?: (handler: () => void) => void;
}

/** The process's own streams. */
export const processIo = (): FilterIo => {
  // #610: in `<filter> | head`, head exits early and the next write fails
  // with EPIPE. The command itself would have died of SIGPIPE in silence, so
  // the filter goes quiet too — no error on stderr, no wait for a drain.
  let closed = false;
  const onClose: (() => void)[] = [];
  process.stdout.on('error', () => {
    closed = true;
    for (const handler of onClose.splice(0)) handler();
  });
  const whenClosed = (handler: () => void) => {
    if (closed) handler();
    else onClose.push(handler);
  };
  return {
    env: process.env,
    stdout: (bytes) => {
      if (!closed) process.stdout.write(bytes);
    },
    stderr: (bytes) => {
      process.stderr.write(bytes);
    },
    stdin: () => Bun.stdin.text(),
    // Drains stdout before exiting, so a large output is never cut.
    flush: () =>
      new Promise((resolve) => {
        if (closed || process.stdout.write('')) resolve();
        else {
          process.stdout.once('drain', () => resolve());
          whenClosed(resolve);
        }
      }),
    onStdoutClosed: whenClosed,
  };
};

/** Runs `filter …` or `filter-hook`; returns the exit code. */
export const runFilterCommand = async (
  argv: readonly string[],
  io: FilterIo = processIo(),
  filters: readonly Filter[] = ALL_FILTERS,
): Promise<number> => {
  const [command, ...rest] = argv;
  if (command === 'filter-hook') {
    let output = '';
    try {
      output = runFilterHook(await io.stdin(), {
        env: io.env,
        filters,
        selfCommand: selfCommand(),
        home: homedir(),
        os: platform(),
        now: Date.now,
      });
    } catch {
      // Fail open: no output is "no decision".
    }
    if (output) io.stdout(output);
    await io.flush();
    return 0;
  }
  const args = rest[0] === '--' ? rest.slice(1) : rest;
  const code = await runFilter(args, {
    env: io.env,
    filters,
    stdout: io.stdout,
    stderr: io.stderr,
    now: Date.now,
    onStdoutClosed: io.onStdoutClosed,
  });
  await io.flush();
  return code;
};

if (import.meta.main) {
  process.exit(await runFilterCommand(process.argv.slice(2)));
}
