import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { TECHNIQUE_READ_GUARD_400, techniqueOn } from './env';
import { renderOutline } from './outline';
import { type StatsTarget, statsTarget, writeStat } from './stats';

/**
 * `nautelle-runner read-hook` (#616): the runner's own guard on `Read`, so a
 * launch with Token saver on has it whether or not the code-sentinel plugin
 * is in the profile. One subcommand serves three hook events:
 *
 * - PreToolUse `Read`: a whole read of a file over the threshold is refused
 *   once with guidance (`tool/read-guard`); a re-read of a range the session
 *   already has, unchanged, is refused once with a reminder
 *   (`tool/read-dedup`). The identical request right after a refusal runs.
 * - PostToolUse `Read`: remembers the range, keyed with the file's mtime and
 *   size, so a read after the file changed is never a repeat.
 * - PreCompact: forgets every read — after compaction nothing is in context.
 *
 * Each refusal writes a stats row: `rawBytes` the estimate of what the read
 * would have returned, `keptBytes` the message that replaced it. The retry it
 * lets through writes a `bypassed` row of its id with no bytes.
 *
 * It fails open: any error prints nothing and exits 0 — the read runs.
 */

/** A whole read is guarded over this many bytes (the card's default). */
export const READ_GUARD_BYTES = 64 * 1024;
/** …or over this many lines, whichever comes first. */
export const READ_GUARD_LINES = 1500;
/** …and over this many under the `read-guard-400` technique (#747 D9). */
export const READ_GUARD_LINES_TIGHT = 400;

export const READ_GUARD_ID = 'tool/read-guard';
export const READ_DEDUP_ID = 'tool/read-dedup';

/** The session's read memory, in the run dir. */
export const READ_GUARD_DIR = 'read-guard';

/** How much of a file is scanned for lines and a binary marker. */
const SCAN_BYTES = 8 * 1024 * 1024;
const BINARY_PROBE = 8 * 1024;
/** Read renders these itself (images, PDF pages); never guarded. */
const MEDIA = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.pdf',
]);
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface ReadInput {
  file_path?: unknown;
  offset?: unknown;
  limit?: unknown;
  pages?: unknown;
}

interface Pending {
  kind: 'guard' | 'dedup';
}

/** What one session has read, and the refusals its next identical call clears. */
export interface ReadMemory {
  read: Record<string, number>;
  denied: Record<string, Pending>;
}

export interface ReadHookDeps {
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
  random?: () => number;
}

export interface DenyOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

const deny = (reason: string): DenyOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

const memoryFile = (target: StatsTarget, sessionId: string): string =>
  join(dirname(target.file), READ_GUARD_DIR, `${sessionId}.json`);

const emptyMemory = (): ReadMemory => ({ read: {}, denied: {} });

const loadMemory = (file: string): ReadMemory => {
  try {
    const json: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof json !== 'object' || json === null) return emptyMemory();
    const { read, denied } = json as Partial<ReadMemory>;
    return {
      read: typeof read === 'object' && read !== null ? read : {},
      denied: typeof denied === 'object' && denied !== null ? denied : {},
    };
  } catch {
    return emptyMemory();
  }
};

/** Atomic: parallel reads of one turn may race, but never tear the file. */
const saveMemory = (file: string, memory: ReadMemory): void => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(memory), { mode: 0o600 });
  renameSync(tmp, file);
};

/** One read's identity: the range asked for and the file as it is now. */
export const readKey = (
  input: ReadInput,
  stat: { mtimeMs: number; size: number },
): string =>
  JSON.stringify([
    input.file_path,
    input.offset ?? null,
    input.limit ?? null,
    input.pages ?? null,
    stat.mtimeMs,
    stat.size,
  ]);

const isWholeRead = (input: ReadInput): boolean =>
  input.offset == null && input.limit == null && input.pages == null;

interface Scan {
  lines: number;
  bytes: Buffer;
}

/** A text file's first `SCAN_BYTES` and its line count; `null` for binary. */
const scan = (path: string, size: number): Scan | null => {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, SCAN_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, read);
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) return null;
    let lines = 0;
    for (const byte of bytes) if (byte === 10) lines++;
    return {
      lines: read > 0 && bytes[read - 1] !== 10 ? lines + 1 : lines,
      bytes,
    };
  } finally {
    closeSync(fd);
  }
};

/** Line count of a text file's first `SCAN_BYTES`; `null` for binary. */
const scanLines = (path: string, size: number): number | null =>
  scan(path, size)?.lines ?? null;

/** What a read of `input` would return, in bytes, roughly. */
const estimateBytes = (input: ReadInput, path: string, size: number) => {
  const limit = typeof input.limit === 'number' ? input.limit : null;
  if (limit === null || size === 0) return size;
  const lines = scanLines(path, size);
  if (!lines) return size;
  return Math.min(size, Math.round((size / lines) * limit));
};

const kib = (bytes: number): string =>
  `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en-US')} KB`;

export const guardMessage = (
  path: string,
  size: number,
  lines: number,
): string =>
  `Nautelle token saver: ${path} is ${lines.toLocaleString('en-US')} lines (${kib(size)}) — not read whole. ` +
  'Read the part you need with offset/limit (Grep finds the line), or ask the `scout` agent to search it. ' +
  'Repeat the same call to read it all.';

/**
 * The refusal under `read-guard-400` (#747 D9): the same notice with the
 * file's outline. "at least" when the file is past the scan.
 */
export const guardMessageWithOutline = (
  path: string,
  size: number,
  scanned: Scan,
): string => {
  const atLeast = size > SCAN_BYTES ? 'at least ' : '';
  return [
    `Nautelle token saver: ${path} is ${atLeast}${scanned.lines.toLocaleString('en-US')} lines (${kib(size)}) — not read whole.`,
    ...renderOutline(scanned.bytes.toString('utf8'), path),
    'Read the part you need with offset/limit (Grep finds the line), or ask the `scout` agent to search it. Repeat the same call to read it all.',
  ].join('\n');
};

export const dedupMessage = (path: string, since: number): string =>
  `Nautelle token saver: ${path} (this range) is already in your context since ${new Date(since).toISOString().slice(11, 19)} UTC and has not changed. ` +
  'Use what you have; repeat the same call to read it again.';

const statOf = (input: ReadInput) => {
  const path = input.file_path;
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat?.isFile() ? { path, stat } : null;
};

/** PreToolUse `Read`: a refusal, or `null` to let the read run. */
const beforeRead = (
  input: ReadInput,
  file: string,
  target: StatsTarget,
  deps: ReadHookDeps,
): DenyOutput | null => {
  const found = statOf(input);
  if (!found) return null;
  const { path, stat } = found;
  const key = readKey(input, stat);
  const memory = loadMemory(file);
  const row = (filter: string, rawBytes: number, keptBytes: number) =>
    writeStat(
      target,
      { filter, rawBytes, keptBytes, bypassed: false, passedThrough: false },
      deps.now(),
      deps.random,
    );

  const pending = memory.denied[key];
  if (pending) {
    delete memory.denied[key];
    saveMemory(file, memory);
    writeStat(
      target,
      {
        filter: pending.kind === 'dedup' ? READ_DEDUP_ID : READ_GUARD_ID,
        rawBytes: 0,
        keptBytes: 0,
        bypassed: true,
        passedThrough: false,
      },
      deps.now(),
      deps.random,
    );
    return null;
  }

  const since = memory.read[key];
  if (since !== undefined) {
    const reason = dedupMessage(path, since);
    const kept = Buffer.byteLength(reason);
    memory.denied[key] = { kind: 'dedup' };
    saveMemory(file, memory);
    const raw = estimateBytes(input, path, stat.size);
    row(READ_DEDUP_ID, Math.max(raw, kept), kept);
    return deny(reason);
  }

  if (!isWholeRead(input) || MEDIA.has(extname(path).toLowerCase())) {
    return null;
  }
  const scanned = scan(path, stat.size);
  if (scanned === null) return null;
  const tight = techniqueOn(deps.env, TECHNIQUE_READ_GUARD_400);
  const limit = tight ? READ_GUARD_LINES_TIGHT : READ_GUARD_LINES;
  if (stat.size <= READ_GUARD_BYTES && scanned.lines <= limit) return null;
  const reason = tight
    ? guardMessageWithOutline(path, stat.size, scanned)
    : guardMessage(path, stat.size, scanned.lines);
  const kept = Buffer.byteLength(reason);
  memory.denied[key] = { kind: 'guard' };
  saveMemory(file, memory);
  row(READ_GUARD_ID, Math.max(stat.size, kept), kept);
  return deny(reason);
};

/** PostToolUse `Read`: the range is in context now. */
const afterRead = (input: ReadInput, file: string, deps: ReadHookDeps) => {
  const found = statOf(input);
  if (!found) return;
  const memory = loadMemory(file);
  memory.read[readKey(input, found.stat)] = deps.now();
  saveMemory(file, memory);
};

/**
 * Runs the hook on one stdin payload and returns what to print (empty for
 * "no decision"). Never throws.
 */
export const runReadHook = (stdin: string, deps: ReadHookDeps): string => {
  try {
    const target = statsTarget(deps.env);
    // Without the launch's env, Token saver is not on for this session.
    if (!target) return '';
    const raw: unknown = JSON.parse(stdin);
    if (typeof raw !== 'object' || raw === null) return '';
    const data = raw as Record<string, unknown>;
    const sessionId = data.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
      return '';
    }
    const file = memoryFile(target, sessionId);
    const event = data.hook_event_name;
    if (event === 'PreCompact') {
      rmSync(file, { force: true });
      return '';
    }
    if (data.tool_name !== 'Read') return '';
    const input = data.tool_input;
    if (typeof input !== 'object' || input === null) return '';
    if (event === 'PreToolUse') {
      const decision = beforeRead(input as ReadInput, file, target, deps);
      return decision ? JSON.stringify(decision) : '';
    }
    if (event === 'PostToolUse') afterRead(input as ReadInput, file, deps);
    return '';
  } catch {
    return '';
  }
};
