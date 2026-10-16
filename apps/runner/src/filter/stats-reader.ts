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
import { join } from 'node:path';
import {
  FILTER_STATS_EVENT,
  FILTER_STATS_MAX_ROWS,
  type FilterStatRow,
  filterStatRowSchema,
} from '@agentdock/shared';
import {
  EVENT_SCHEMA_VERSION,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { errorMessage, type Logger } from '../log';
import { FILTER_RAW_DIR, FILTER_STATS_FILE } from './env';

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
/** Run dirs sit at most this deep under a root (`<root>/<id>[/<round>]`). */
const MAX_DEPTH = 2;

const lineSchema = z.object({
  projectId: z.string().min(1).max(64),
  row: filterStatRowSchema,
});

type EnvelopeProject = NonNullable<UnsequencedEvent['project']>;

export interface FilterStatsReaderOptions {
  /** The executors' base dirs and the orchestrator's; missing ones are skipped. */
  roots: () => readonly string[];
  /** The envelope of each project id; ids the runner does not watch are absent. */
  resolve: (projectIds: string[]) => Promise<Map<string, EnvelopeProject>>;
  emit: (event: UnsequencedEvent) => void;
  log: Logger;
  now: () => Date;
  pollMs?: number;
}

/** Every `filter-stats.jsonl` under the roots, at most `MAX_DEPTH` levels down. */
export const findStatsFiles = (roots: readonly string[]): string[] => {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === FILTER_STATS_FILE && depth > 0) {
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

/** Valid rows grouped by project; bad lines are counted, never sent. */
export const parseLines = (
  lines: readonly string[],
): { byProject: Map<string, FilterStatRow[]>; rejected: number } => {
  const byProject = new Map<string, FilterStatRow[]>();
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
    if (!parsed.success) {
      rejected++;
      continue;
    }
    const rows = byProject.get(parsed.data.projectId) ?? [];
    rows.push(parsed.data.row);
    byProject.set(parsed.data.projectId, rows);
  }
  return { byProject, rejected };
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
    for (const file of findStatsFiles(this.options.roots())) {
      try {
        await this.drain(file);
      } catch (error) {
        log.warn('filter stats: cannot read', {
          file,
          error: errorMessage(error),
        });
      }
    }
  }

  private async drain(file: string): Promise<void> {
    const { lines, next } = readNewLines(file, readOffset(file));
    if (lines.length > 0) {
      const { byProject, rejected } = parseLines(lines);
      if (rejected > 0) {
        this.options.log.warn('filter stats: skipped malformed rows', {
          file,
          rejected,
        });
      }
      const projects = await this.options.resolve([...byProject.keys()]);
      for (const [projectId, rows] of byProject) {
        const project = projects.get(projectId);
        // A project the runner no longer watches: nowhere to report it.
        if (!project) continue;
        for (let i = 0; i < rows.length; i += FILTER_STATS_MAX_ROWS) {
          this.options.emit({
            v: EVENT_SCHEMA_VERSION,
            ts: this.options.now().toISOString(),
            type: FILTER_STATS_EVENT,
            source: 'runner',
            project,
            data: { rows: rows.slice(i, i + FILTER_STATS_MAX_ROWS) },
          });
        }
      }
    }
    // Written only after the rows are in the spool (`emit` appends synchronously).
    if (next !== readOffset(file)) {
      writeFileSync(offsetFileOf(file), `${next}\n`, { mode: 0o600 });
    }
  }
}
