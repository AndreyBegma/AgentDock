import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  EVENT_SCHEMA_VERSION,
  eventSchema,
  MAX_EVENTS_BATCH_BYTES,
  type RunnerEvent,
  SPOOL_TRUNCATED_EVENT,
  type SpoolTruncatedData,
  seqCursorSchema,
  type UnsequencedEvent,
  unsequencedEventSchema,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import type { Logger } from './log';

export const SEGMENT_BYTES = 10 * 1024 * 1024;
export const SPOOL_CAP_BYTES = 100 * 1024 * 1024;
/** Room left in a batch for the `{"type":"events","events":[…]}` wrapper. */
const BATCH_OVERHEAD_BYTES = 64;

const SEGMENT_FILE = /^(\d{20})\.jsonl$/;
const META_FILE = 'meta.json';

const metaSchema = z.object({
  lastSeq: seqCursorSchema,
  ackedSeq: seqCursorSchema,
});
type Meta = z.infer<typeof metaSchema>;

interface Segment {
  firstSeq: number;
  path: string;
  bytes: number;
}

export interface SpoolStats {
  segments: number;
  bytes: number;
  lastSeq: number;
  ackedSeq: number;
}

export interface SpoolOptions {
  dir: string;
  log: Logger;
  segmentBytes?: number;
  capBytes?: number;
  now?: () => Date;
}

export class SpoolError extends Error {}

const segmentName = (firstSeq: number): string =>
  `${String(firstSeq).padStart(20, '0')}.jsonl`;

const listSegments = (dir: string): Segment[] =>
  readdirSync(dir)
    .map((name) => ({ name, match: SEGMENT_FILE.exec(name) }))
    .filter(
      (e): e is { name: string; match: RegExpExecArray } => e.match !== null,
    )
    .map(({ name, match }) => {
      const path = join(dir, name);
      return { firstSeq: Number(match[1]), path, bytes: statSync(path).size };
    })
    .sort((a, b) => a.firstSeq - b.firstSeq);

const readMeta = (dir: string): Meta => {
  try {
    return metaSchema.parse(
      JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')),
    );
  } catch {
    return { lastSeq: 0, ackedSeq: 0 };
  }
};

/** The `seq` of a complete spool line; null for a torn or foreign one. */
const seqOfLine = (line: string): number | null => {
  try {
    const parsed = eventSchema.shape.seq.safeParse(
      (JSON.parse(line) as { seq?: unknown }).seq,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Parses one segment's lines; a line that fails to parse is reported and skipped. */
const readSegment = (path: string, log: Logger): RunnerEvent[] => {
  const events: RunnerEvent[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    let parsed: ReturnType<typeof eventSchema.safeParse>;
    try {
      parsed = eventSchema.safeParse(JSON.parse(line));
    } catch {
      log.warn('spool: skipped an unreadable line', { segment: path });
      continue;
    }
    if (parsed.success) events.push(parsed.data);
    else log.warn('spool: skipped an invalid event', { segment: path });
  }
  return events;
};

/**
 * Append-only JSONL event spool (D7). Segments are named after their first
 * `seq`; `meta.json` keeps `lastSeq` and `ackedSeq` so `seq` survives a
 * restart even when every segment has been acked and deleted.
 */
export class Spool {
  private segments: Segment[];
  private meta: Meta;

  private constructor(
    private readonly options: Required<SpoolOptions>,
    segments: Segment[],
    meta: Meta,
  ) {
    this.segments = segments;
    this.meta = meta;
  }

  static open(options: SpoolOptions): Spool {
    const resolved: Required<SpoolOptions> = {
      segmentBytes: SEGMENT_BYTES,
      capBytes: SPOOL_CAP_BYTES,
      now: () => new Date(),
      ...options,
    };
    mkdirSync(resolved.dir, { recursive: true, mode: 0o700 });
    const segments = listSegments(resolved.dir);
    const meta = readMeta(resolved.dir);

    const newest = segments.at(-1);
    if (newest) {
      Spool.repairTail(newest, resolved.log);
      const tail = readSegment(newest.path, resolved.log).at(-1);
      meta.lastSeq = Math.max(meta.lastSeq, tail?.seq ?? newest.firstSeq - 1);
    }
    meta.ackedSeq = Math.min(meta.ackedSeq, meta.lastSeq);
    const spool = new Spool(resolved, segments, meta);
    spool.writeMeta();
    return spool;
  }

  /** Stats without opening for writing — safe while a daemon owns the spool. */
  static inspect(dir: string): SpoolStats {
    if (!existsSync(dir))
      return { segments: 0, bytes: 0, lastSeq: 0, ackedSeq: 0 };
    const segments = listSegments(dir);
    const meta = readMeta(dir);
    const newest = segments.at(-1);
    if (newest) {
      const lines = readFileSync(newest.path, 'utf8').split('\n').reverse();
      const tail = lines.map(seqOfLine).find((seq) => seq !== null);
      if (tail) meta.lastSeq = Math.max(meta.lastSeq, tail);
    }
    return {
      segments: segments.length,
      bytes: segments.reduce((sum, s) => sum + s.bytes, 0),
      lastSeq: meta.lastSeq,
      ackedSeq: meta.ackedSeq,
    };
  }

  /** A crash mid-append leaves a torn last line; cut it so the next append starts clean. */
  private static repairTail(segment: Segment, log: Logger): void {
    const content = readFileSync(segment.path);
    if (content.length === 0 || content[content.length - 1] === 0x0a) return;
    const keep = content.lastIndexOf(0x0a) + 1;
    truncateSync(segment.path, keep);
    segment.bytes = keep;
    log.warn('spool: cut a torn last line', { segment: segment.path });
  }

  get lastSeq(): number {
    return this.meta.lastSeq;
  }

  get ackedSeq(): number {
    return this.meta.ackedSeq;
  }

  stats(): SpoolStats {
    return {
      segments: this.segments.length,
      bytes: this.segments.reduce((sum, s) => sum + s.bytes, 0),
      lastSeq: this.meta.lastSeq,
      ackedSeq: this.meta.ackedSeq,
    };
  }

  /**
   * Assigns the next `seq` and persists the event. Returns what was appended:
   * the event, followed by a `runner.spool_truncated` event when the cap made
   * the spool drop its oldest segments.
   */
  append(event: UnsequencedEvent): RunnerEvent[] {
    const valid = unsequencedEventSchema.parse(event);
    const appended = [this.write(valid)];
    const truncated = this.enforceCap();
    if (truncated) {
      appended.push(
        this.write({
          v: EVENT_SCHEMA_VERSION,
          ts: this.options.now().toISOString(),
          type: SPOOL_TRUNCATED_EVENT,
          source: 'runner',
          data: truncated,
        }),
      );
    }
    return appended;
  }

  /** The server persisted everything up to `seq`: delete the segments it covers. */
  ack(seq: number): void {
    const acked = Math.min(seq, this.meta.lastSeq);
    if (seq > this.meta.lastSeq) {
      this.options.log.warn('spool: ack above the last seq', {
        seq,
        lastSeq: this.meta.lastSeq,
      });
    }
    if (acked <= this.meta.ackedSeq) return;
    this.meta.ackedSeq = acked;
    this.writeMeta();
    while (this.segments.length > 0 && this.segmentLastSeq(0) <= acked) {
      const [segment] = this.segments.splice(0, 1);
      rmSync(segment.path, { force: true });
    }
  }

  /** Every spooled event with `seq > after`, in order, one segment at a time. */
  *eventsAfter(after: number): Generator<RunnerEvent> {
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segmentLastSeq(i) <= after) continue;
      for (const event of readSegment(
        this.segments[i].path,
        this.options.log,
      )) {
        if (event.seq > after) yield event;
      }
    }
  }

  private segmentLastSeq(index: number): number {
    const next = this.segments[index + 1];
    return next ? next.firstSeq - 1 : this.meta.lastSeq;
  }

  private write(event: UnsequencedEvent): RunnerEvent {
    const sequenced: RunnerEvent = { ...event, seq: this.meta.lastSeq + 1 };
    const line = `${JSON.stringify(sequenced)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_EVENTS_BATCH_BYTES - BATCH_OVERHEAD_BYTES) {
      throw new SpoolError(
        `event ${event.type} is ${bytes} bytes, over the batch limit`,
      );
    }
    let active = this.segments.at(-1);
    if (
      !active ||
      (active.bytes > 0 && active.bytes + bytes > this.options.segmentBytes)
    ) {
      active = {
        firstSeq: sequenced.seq,
        path: join(this.options.dir, segmentName(sequenced.seq)),
        bytes: 0,
      };
      this.segments.push(active);
    }
    appendFileSync(active.path, line, { mode: 0o600 });
    active.bytes += bytes;
    this.meta.lastSeq = sequenced.seq;
    return sequenced;
  }

  /** Drops the oldest segments while over the cap; returns the unacked range lost. */
  private enforceCap(): SpoolTruncatedData | null {
    let total = this.segments.reduce((sum, s) => sum + s.bytes, 0);
    let lost: SpoolTruncatedData | null = null;
    while (total > this.options.capBytes && this.segments.length > 1) {
      const fromSeq = Math.max(
        this.segments[0].firstSeq,
        this.meta.ackedSeq + 1,
      );
      const toSeq = this.segmentLastSeq(0);
      const [segment] = this.segments.splice(0, 1);
      rmSync(segment.path, { force: true });
      total -= segment.bytes;
      if (toSeq < fromSeq) continue;
      lost = lost
        ? { fromSeq: lost.fromSeq, toSeq, bytes: lost.bytes + segment.bytes }
        : { fromSeq, toSeq, bytes: segment.bytes };
    }
    if (lost) {
      this.options.log.warn(
        'spool: cap reached, dropped the oldest events',
        lost,
      );
      this.writeMeta();
    }
    return lost;
  }

  private writeMeta(): void {
    const path = join(this.options.dir, META_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.meta), { mode: 0o600 });
    renameSync(tmp, path);
  }
}
