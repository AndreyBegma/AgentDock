import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  FILTER_STATS_EVENT,
  FILTER_STATS_MAX_ROWS,
  type FilterStatRow,
  filterStatRowSchema,
} from '@nautelle/shared';
import {
  EVENT_SCHEMA_VERSION,
  PREFIX_MEASURED_EVENT,
  PREFIX_OVERLAY_STALE_EVENT,
  type UnsequencedEvent,
  type WatchedProject,
} from '@nautelle/shared/protocol';
import { z } from 'zod';
import { correlateCwd } from '../adapters/correlate';
import { errorMessage, type Logger } from '../log';
import {
  PREFIX_MEASURED_FILE,
  PREFIX_MEASURED_SENT_FILE,
  prefixRecordSchema,
} from '../prefix/record';
import { type EcoSessionFile, findEcoStatsFiles, parseEcoLines } from './eco';
import { FILTER_RAW_DIR, FILTER_RUN_FILE, FILTER_STATS_FILE } from './env';

/**
 * The daemon's side of the stats transport (#445 amendment 5): the `filter`
 * processes append rows to `<run dir>/filter-stats.jsonl`; this reads them in
 * batches and sends `filter.stats` through the ordinary events stream, so
 * they are spooled, resent and acked like every other event.
 *
 * Where it got to in each file is kept beside it (`filter-stats.offset`), so
 * a restart does not resend what is already in the spool. A resend after a
 * crash between the two is harmless: the API skips row ids it has.
 */

/** The read position beside each stats file. */
export const FILTER_STATS_OFFSET_FILE = 'filter-stats.offset';
/** How often the run dirs are scanned. */
export const FILTER_STATS_POLL_MS = 5_000;
/** Bytes read from one file per pass; the rest waits for the next pass. */
const READ_CHUNK_BYTES = 1024 * 1024;
/**
 * Run dirs sit at most this deep under a root: `<root>/<id>`, and a card's
 * rounds at `<cards>/<card>/rounds/<run>`.
 */
const MAX_DEPTH = 3;

const projectIdSchema = z.string().min(1).max(64);

const lineSchema = z.object({
  projectId: projectIdSchema,
  row: filterStatRowSchema,
});

const identitySchema = z.object({
  projectId: projectIdSchema,
  runId: filterStatRowSchema.shape.runId,
  runKind: filterStatRowSchema.shape.runKind,
});

type EnvelopeProject = NonNullable<UnsequencedEvent['project']>;

/** `/cs-eco` sessions the runner did not launch (#475). */
export interface EcoStatsSource {
  /** `/cs-eco`'s sessions directory; a missing one has no sessions. */
  dir: string;
  projects: () => readonly WatchedProject[];
  /** A Claude session's cwd, when it is known. */
  sessionCwd: (sessionId: string) => string | undefined;
}

export interface FilterStatsReaderOptions {
  /** The executors' base dirs and the orchestrator's; missing ones are skipped. */
  roots: () => readonly string[];
  eco?: EcoStatsSource;
  /** The envelope of each project id; ids the runner does not watch are absent. */
  resolve: (projectIds: string[]) => Promise<Map<string, EnvelopeProject>>;
  emit: (event: UnsequencedEvent) => void;
  log: Logger;
  now: () => Date;
  pollMs?: number;
}

/** Every `filter-stats.jsonl` under the roots, at most `MAX_DEPTH` levels down. */
export const findStatsFiles = (roots: readonly string[]): string[] =>
  findRunFiles(roots, [FILTER_STATS_FILE]);

/** Every run-dir file named one of `names` under the roots, at most `MAX_DEPTH` levels down. */
export const findRunFiles = (
  roots: readonly string[],
  names: readonly string[],
): string[] => {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && names.includes(entry.name) && depth > 0) {
        found.push(join(dir, entry.name));
      } else if (
        entry.isDirectory() &&
        depth < MAX_DEPTH &&
        entry.name !== FILTER_RAW_DIR &&
        !entry.name.startsWith('.')
      ) {
        walk(join(dir, entry.name), depth + 1);
      }
    }
  };
  for (const root of roots) walk(root, 0);
  return found;
};

const offsetFileOf = (statsFile: string): string =>
  join(statsFile, '..', FILTER_STATS_OFFSET_FILE);

const writeOffset = (statsFile: string, next: number): void => {
  if (next !== readOffset(statsFile)) {
    writeFileSync(offsetFileOf(statsFile), `${next}\n`, { mode: 0o600 });
  }
};

const readOffset = (statsFile: string): number => {
  const file = offsetFileOf(statsFile);
  if (!existsSync(file)) return 0;
  const value = Number(readFileSync(file, 'utf8').trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

/** The complete lines after `offset`, and the offset after the last of them. */
export const readNewLines = (
  statsFile: string,
  offset: number,
): { lines: string[]; next: number } => {
  const fd = openSync(statsFile, 'r');
  try {
    const size = fstatSync(fd).size;
    // A file shorter than the offset was replaced: start it over.
    const from = size < offset ? 0 : offset;
    const length = Math.min(size - from, READ_CHUNK_BYTES);
    if (length <= 0) return { lines: [], next: from };
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, from);
    const text = buffer.subarray(0, read).toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) {
      // One line longer than a chunk is not a row: skip it.
      return read === READ_CHUNK_BYTES
        ? { lines: [], next: from + read }
        : { lines: [], next: from };
    }
    const complete = text.slice(0, end);
    return {
      lines: complete.split('\n').filter((l) => l.trim().length > 0),
      next: from + Buffer.byteLength(complete) + 1,
    };
  } finally {
    closeSync(fd);
  }
};

/** Who a run dir belongs to, as its launch wrote it (`FILTER_RUN_FILE`). */
export type RunIdentity = z.infer<typeof identitySchema>;

/** The run dir's identity, or `null` when it is missing or does not parse. */
export const readIdentity = (statsFile: string): RunIdentity | null => {
  try {
    const parsed = identitySchema.safeParse(
      JSON.parse(
        readFileSync(join(dirname(statsFile), FILTER_RUN_FILE), 'utf8'),
      ),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * The valid rows of one run dir. A row is the dir's only when its project,
 * run and kind are the dir's identity (DR-05): a session writing rows for
 * another project or run gets them counted as rejected, never sent.
 */
export const parseLines = (
  lines: readonly string[],
  identity: RunIdentity,
): { rows: FilterStatRow[]; rejected: number } => {
  const rows: FilterStatRow[] = [];
  let rejected = 0;
  for (const line of lines) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      rejected++;
      continue;
    }
    const parsed = lineSchema.safeParse(json);
    if (
      !parsed.success ||
      parsed.data.projectId !== identity.projectId ||
      parsed.data.row.runId !== identity.runId ||
      parsed.data.row.runKind !== identity.runKind
    ) {
      rejected++;
      continue;
    }
    rows.push(parsed.data.row);
  }
  return { rows, rejected };
};

export class FilterStatsReader {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: FilterStatsReaderOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.options.pollMs ?? FILTER_STATS_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every stats file. Never throws; overlapping passes are joined. */
  poll(): Promise<void> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async pass(): Promise<void> {
    const { log } = this.options;
    const files = findRunFiles(this.options.roots(), [
      FILTER_STATS_FILE,
      PREFIX_MEASURED_FILE,
    ]);
    for (const file of files) {
      try {
        if (basename(file) === PREFIX_MEASURED_FILE)
          await this.sendPrefix(file);
        else await this.drain(file);
      } catch (error) {
        log.warn('filter stats: cannot read', {
          file,
          error: errorMessage(error),
        });
      }
    }
    const { eco } = this.options;
    if (!eco) return;
    for (const session of findEcoStatsFiles(eco.dir)) {
      try {
        await this.drainEco(eco, session);
      } catch (error) {
        log.warn('filter stats: cannot read', {
          file: session.file,
          error: errorMessage(error),
        });
      }
    }
  }

  /** `session`: a `/cs-eco` batch's Claude session id (#748 D5). */
  private emitRows(
    project: EnvelopeProject,
    rows: FilterStatRow[],
    session?: string,
  ): void {
    for (let i = 0; i < rows.length; i += FILTER_STATS_MAX_ROWS) {
      this.options.emit({
        v: EVENT_SCHEMA_VERSION,
        ts: this.options.now().toISOString(),
        type: FILTER_STATS_EVENT,
        source: 'runner',
        project,
        data: {
          rows: rows.slice(i, i + FILTER_STATS_MAX_ROWS),
          ...(session ? { session } : {}),
        },
      });
    }
  }

  /**
   * One `/cs-eco` session (#475). Its project is the watched root its cwd is
   * in; a session outside every watched root, or whose cwd is not known yet,
   * is left unread — its rows wait, and go nowhere.
   */
  private async drainEco(
    eco: EcoStatsSource,
    { sessionId, file }: EcoSessionFile,
  ): Promise<void> {
    const cwd = eco.sessionCwd(sessionId);
    if (!cwd) return;
    const watched = eco.projects();
    const { projectId } = correlateCwd(cwd, watched);
    const root = watched.find((p) => p.id === projectId)?.root;
    if (!projectId || !root) return;
    const project = (await this.options.resolve([projectId])).get(projectId);
    if (!project) return;
    const { lines, next } = readNewLines(file, readOffset(file));
    if (lines.length > 0) {
      const { rows, rejected } = parseEcoLines(lines, {
        sessionId,
        projectId,
        repo: project.repo,
        root,
      });
      if (rejected > 0) {
        this.options.log.warn(
          'filter stats: skipped malformed or foreign rows',
          { file, rejected },
        );
      }
      this.emitRows(project, rows, sessionId);
    }
    writeOffset(file, next);
  }

  private async drain(file: string): Promise<void> {
    const identity = readIdentity(file);
    // Not a launch's run dir, or not one yet: nobody to count the rows for.
    if (!identity) {
      this.options.log.debug('filter stats: no run identity', { file });
      return;
    }
    const { lines, next } = readNewLines(file, readOffset(file));
    if (lines.length > 0) {
      const { rows, rejected } = parseLines(lines, identity);
      if (rejected > 0) {
        this.options.log.warn(
          'filter stats: skipped malformed or foreign rows',
          {
            file,
            rejected,
          },
        );
      }
      const project = (await this.options.resolve([identity.projectId])).get(
        identity.projectId,
      );
      // A project the runner no longer watches: nowhere to report it.
      if (project) this.emitRows(project, rows);
    }
    // Written only after the rows are in the spool (`emit` appends synchronously).
    writeOffset(file, next);
  }

  /**
   * #751 B1, B10: a launch's prefix record, sent once as `prefix.measured`
   * and one `prefix.overlay_stale` per stale overlay. A record that is not
   * the run dir's own (its run or kind differs) is dropped, never sent.
   */
  private async sendPrefix(file: string): Promise<void> {
    const sent = join(dirname(file), PREFIX_MEASURED_SENT_FILE);
    if (existsSync(sent)) return;
    const identity = readIdentity(file);
    if (!identity) return;
    const markSent = () => writeFileSync(sent, '', { mode: 0o600 });
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      json = null;
    }
    const parsed = prefixRecordSchema.safeParse(json);
    if (
      !parsed.success ||
      parsed.data.measured.runId !== identity.runId ||
      parsed.data.measured.launchKind !== identity.runKind ||
      parsed.data.stale.some((s) => s.runId !== identity.runId)
    ) {
      this.options.log.warn('filter stats: skipped a malformed prefix record', {
        file,
      });
      markSent();
      return;
    }
    const project = (await this.options.resolve([identity.projectId])).get(
      identity.projectId,
    );
    if (project) {
      const event = (type: string, data: unknown): UnsequencedEvent => ({
        v: EVENT_SCHEMA_VERSION,
        ts: this.options.now().toISOString(),
        type,
        source: 'runner',
        project,
        data,
      });
      this.options.emit(event(PREFIX_MEASURED_EVENT, parsed.data.measured));
      for (const stale of parsed.data.stale) {
        this.options.emit(event(PREFIX_OVERLAY_STALE_EVENT, stale));
      }
    }
    // Written only after the events are in the spool, as the offset is.
    markSent();
  }
}
