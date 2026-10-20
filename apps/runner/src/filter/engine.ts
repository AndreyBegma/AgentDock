import { constants } from 'node:os';
import { basename, dirname } from 'node:path';
import { redact } from '../pane/redact';
import { type LinePart, missingProtectedLines } from './classify';
import { RAW_ENV } from './env';
import { programOf } from './program';
import { RAW_CAP_BYTES, RawFile } from './raw-store';
import {
  type StatsCounts,
  type StatsTarget,
  statsTarget,
  writeStat,
} from './stats';
import type { Filter } from './types';

/** The filter id of a command no family covers. Mirrors `FILTER_ID_NONE`. */
export const FILTER_NONE = 'none';

/**
 * Amendment 12: why no filter ran, mirroring `FILTER_ID_NONE_*` — not a
 * line the hook parses (amendment 13), no pipeline head covered, or a mode
 * that never rewrites.
 */
export const FILTER_NONE_COMPOUND = 'none:compound';
export const FILTER_NONE_UNCOVERED = 'none:uncovered';
export const FILTER_NONE_MODE = 'none:mode';

/** Output past this size is not filtered: it streams through unchanged. */
export const FILTER_BUFFER_BYTES = RAW_CAP_BYTES;

export interface FilterDeps {
  env: Readonly<Record<string, string | undefined>>;
  filters: readonly Filter[];
  stdout: (bytes: Uint8Array | string) => void;
  stderr: (bytes: Uint8Array | string) => void;
  now: () => number;
  random?: () => number;
  /** Signals forwarded to the child; the process's own by default. */
  onSignal?: (handler: (signal: NodeJS.Signals) => void) => () => void;
  /**
   * Calls `handler` once stdout is closed — `| head` has read all it wants
   * (#610). The child then gets the SIGPIPE it would have got writing there
   * itself.
   */
  onStdoutClosed?: (handler: () => void) => void;
}

type Stream = 'out' | 'err';
interface Chunk {
  stream: Stream;
  bytes: Uint8Array;
}

/** The footer every compressed output ends with (D4a). */
export const filterFooter = (
  hidden: number,
  rawPath: string,
  truncated: boolean,
): string =>
  `[nautelle filter: ${hidden} lines hidden · full output${truncated ? ' (first 10 MB, truncated)' : ''}: ${rawPath} · ${RAW_ENV}=1 to bypass]\n`;

/** The program a filter matches on: the bare name, without its directory. */
export const commandArgv = (argv: readonly string[]): string[] =>
  argv.length === 0 ? [] : [basename(argv[0] ?? ''), ...argv.slice(1)];

export const findFilter = (
  filters: readonly Filter[],
  argv: readonly string[],
): Filter | null => {
  const bare = commandArgv(argv);
  for (const filter of filters) {
    try {
      if (filter.matches(bare)) return filter;
    } catch {
      // A filter that cannot decide does not get the command.
    }
  }
  return null;
};

export type Verdict =
  | { kind: 'filtered'; text: string }
  | { kind: 'original'; reason: string };

/**
 * Applies a filter and checks it (D4b): it must not throw, must keep every
 * protected line, and must come out shorter, footer included. Anything else
 * returns the original.
 */
export const judge = (
  filter: Filter,
  argv: readonly string[],
  output: string,
  exitCode: number,
  footer: (hidden: number) => string,
): Verdict => {
  let result: string | null;
  try {
    result = filter.apply({ argv: commandArgv(argv), output, exitCode });
  } catch {
    return { kind: 'original', reason: 'threw' };
  }
  if (result === null) return { kind: 'original', reason: 'unclassified' };
  let missing: string[];
  try {
    missing = missingProtectedLines(output, result, linePart(filter));
  } catch {
    return { kind: 'original', reason: 'threw' };
  }
  if (missing.length > 0) return { kind: 'original', reason: 'lost a line' };
  const body =
    result.length === 0 || result.endsWith('\n') ? result : `${result}\n`;
  const hidden = Math.max(0, lineCount(output) - lineCount(body));
  const text = `${body}${footer(hidden)}`;
  if (Buffer.byteLength(text) >= Buffer.byteLength(output)) {
    return { kind: 'original', reason: 'not shorter' };
  }
  return { kind: 'filtered', text };
};

/** How the classifier reads a line of this filter's command (`Filter.protectedPart`). */
export const linePart =
  (filter: Filter): LinePart =>
  (line) =>
    filter.protectedPart?.(line) ?? line;

/**
 * The compressed output, redacted by the runner's one redactor
 * (`pane/redact.ts`, C-128), which loads no protocol schemas onto this hot
 * path.
 */
export const redactShown = (text: string): string =>
  redact(text.split('\n')).join('\n');

const lineCount = (text: string): number => {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n : n + 1;
};

/** A shell's exit code for a command killed by a signal. */
const signalExit = (signal: string): number =>
  128 +
  ((constants.signals as Record<string, number | undefined>)[signal] ?? 1);

const processSignals = (
  handler: (signal: NodeJS.Signals) => void,
): (() => void) => {
  // The filter process exits right after its one command, so the listeners
  // are never removed; killing an exited child is a no-op.
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGHUP', () => handler('SIGHUP'));
  return () => {};
};

/**
 * `nautelle-runner filter -- <argv…>` (#445 D3, D4): runs the command, keeps
 * its raw output in the run dir, and prints a compressed version when a
 * filter covers the command and passes the checks. The exit code is the
 * command's own. Returns it.
 */
export const runFilter = async (
  argv: readonly string[],
  deps: FilterDeps,
): Promise<number> => {
  if (argv.length === 0) {
    deps.stderr('nautelle filter: no command given\n');
    return 2;
  }
  const target = safe(() => statsTarget(deps.env));
  const bypass = deps.env[RAW_ENV] === '1';
  const program = programOf(argv);

  let child: ReturnType<typeof Bun.spawn<'inherit', 'pipe', 'pipe'>>;
  try {
    child = Bun.spawn([...argv], {
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...deps.env },
    });
  } catch {
    deps.stderr(`${argv[0]}: command not found\n`);
    if (target) {
      record(deps, target, {
        filter: FILTER_NONE,
        program,
        rawBytes: 0,
        keptBytes: 0,
        bypassed: bypass,
        passedThrough: !bypass,
      });
    }
    return 127;
  }
  const unhook = (deps.onSignal ?? processSignals)((signal) => {
    child.kill(signal);
  });
  deps.onStdoutClosed?.(() => {
    child.kill('SIGPIPE');
  });

  // Without a target there is nowhere to keep the raw output: stay out of the way.
  const raw =
    target && !bypass ? safe(() => RawFile.create(dirname(target.file))) : null;
  // Matched with the bypass too, so the bypass rate is per filter.
  const filter = target ? findFilter(deps.filters, argv) : null;

  const chunks: Chunk[] = [];
  let total = 0;
  let streaming = !filter || !raw;
  const forward = (chunk: Chunk) =>
    chunk.stream === 'out'
      ? deps.stdout(chunk.bytes)
      : deps.stderr(chunk.bytes);

  const pump = async (stream: ReadableStream<Uint8Array>, name: Stream) => {
    for await (const bytes of stream) {
      const chunk = { stream: name, bytes };
      total += bytes.byteLength;
      if (raw) safe(() => raw.write(bytes));
      if (streaming) {
        forward(chunk);
        continue;
      }
      chunks.push(chunk);
      if (total > FILTER_BUFFER_BYTES) {
        // Too big to hold: what arrived so far goes out, the rest streams.
        streaming = true;
        for (const held of chunks.splice(0)) forward(held);
      }
    }
  };

  await Promise.all([pump(child.stdout, 'out'), pump(child.stderr, 'err')]);
  const exited = await child.exited;
  const code = child.signalCode
    ? signalExit(child.signalCode)
    : (child.exitCode ?? exited);
  unhook();
  if (raw) safe(() => raw.close());

  let counts: StatsCounts;
  if (bypass || !filter || streaming || !raw) {
    for (const held of chunks.splice(0)) forward(held);
    counts = {
      filter: filter?.id ?? FILTER_NONE_UNCOVERED,
      program,
      rawBytes: total,
      keptBytes: total,
      bypassed: bypass,
      passedThrough: !bypass,
    };
  } else {
    const output = new TextDecoder().decode(concat(chunks));
    const verdict = judge(filter, argv, output, code, (hidden) =>
      filterFooter(hidden, raw.path, raw.truncated),
    );
    if (verdict.kind === 'filtered') {
      // DR-07: what the agent reads is redacted; the raw file keeps every byte.
      const shown = redactShown(verdict.text);
      deps.stdout(shown);
      const kept = Buffer.byteLength(shown);
      counts = {
        filter: filter.id,
        program,
        rawBytes: total,
        keptBytes: Math.min(kept, total),
        bypassed: false,
        passedThrough: false,
      };
    } else {
      for (const held of chunks) forward(held);
      counts = {
        filter: filter.id,
        program,
        rawBytes: total,
        keptBytes: total,
        bypassed: false,
        passedThrough: true,
      };
    }
  }
  if (target) record(deps, target, counts);
  return code;
};

const record = (deps: FilterDeps, target: StatsTarget, counts: StatsCounts) =>
  writeStat(target, counts, deps.now(), deps.random);

const concat = (chunks: readonly Chunk[]): Uint8Array => {
  const size = chunks.reduce((sum, c) => sum + c.bytes.byteLength, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const { bytes } of chunks) {
    out.set(bytes, at);
    at += bytes.byteLength;
  }
  return out;
};

/** Runs `fn`; a throw means "not available", never a failed command (fail open). */
const safe = <T>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};
