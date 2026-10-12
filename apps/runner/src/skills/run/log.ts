import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  isTerminalSkillRunPhase,
  PANE_MAX_SUBSCRIPTIONS,
  RUN_LOG_BACKLOG_LINES,
  RUN_LOG_MAX_FRAME_BYTES,
  type RunLogLine,
  type RunLogMessage,
  type RunLogSubscribeMessage,
  type SubscribeErrorMessage,
} from '@agentdock/shared/protocol';
import type { Cancel, Clock } from '../../clock';
import { errorMessage, type Logger } from '../../log';
import type { RunRecord } from './record';
import { renderStreamLine } from './stream';

/** How often subscribed run logs are tailed. */
export const RUN_LOG_POLL_MS = 500;
/** At most this much new stream is read per subscription and poll. */
const READ_CHUNK_BYTES = 1024 * 1024;

export type RunLogOutbound = RunLogMessage | SubscribeErrorMessage;

export interface RunLogSource {
  record(runId: string): RunRecord | null;
  streamFile(runId: string): string;
}

export interface RunLogOptions {
  runs: RunLogSource;
  send: (message: RunLogOutbound) => boolean;
  clock: Clock;
  log: Logger;
  intervalMs?: number;
  maxSubscriptions?: number;
}

interface Subscription {
  id: string;
  runId: string;
  /** Bytes of `stream.jsonl` consumed: always the end of a whole line. */
  offset: number;
  /** Inside a line longer than a chunk: dropped up to its end. */
  skipping: boolean;
}

/**
 * Splits rendered lines into `run_log` frames under `RUN_LOG_MAX_FRAME_BYTES`
 * serialized (D13).
 */
export const runLogFrames = (
  id: string,
  lines: readonly RunLogLine[],
  backlog: boolean,
): RunLogMessage[] => {
  const frames: RunLogMessage[] = [];
  const frame = (batch: RunLogLine[]): RunLogMessage => ({
    type: 'run_log',
    id,
    frame: { type: 'lines', backlog, lines: batch },
  });
  let batch: RunLogLine[] = [];
  let size = Buffer.byteLength(JSON.stringify(frame([])));
  for (const line of lines) {
    const lineSize = Buffer.byteLength(JSON.stringify(line)) + 1;
    if (batch.length > 0 && size + lineSize > RUN_LOG_MAX_FRAME_BYTES) {
      frames.push(frame(batch));
      batch = [];
      size = Buffer.byteLength(JSON.stringify(frame([])));
    }
    batch.push(line);
    size += lineSize;
  }
  if (batch.length > 0) frames.push(frame(batch));
  return frames;
};

/**
 * The live log of skill runs (D13). While the server holds a `run_log`
 * subscription, the runner tails the run's `stream.jsonl` and sends rendered
 * lines — the newest backlog first, then live lines — and an `ended` frame
 * at the run's terminal phase. The stream itself never leaves the runner.
 */
export class RunLogStreamer {
  private readonly subs = new Map<string, Subscription>();
  private cancelPoll: Cancel = () => {};
  private polling = false;

  constructor(private readonly options: RunLogOptions) {}

  get subscriptionCount(): number {
    return this.subs.size;
  }

  subscribe(message: RunLogSubscribeMessage): void {
    const { id, projectId, runId } = message;
    if (this.subs.has(id)) return;
    const record = this.options.runs.record(runId);
    if (!record || record.projectId !== projectId) {
      this.refuse(id, 'not_found');
      return;
    }
    if (
      this.subs.size >=
      (this.options.maxSubscriptions ?? PANE_MAX_SUBSCRIPTIONS)
    ) {
      this.refuse(id, 'too_many_viewers');
      return;
    }
    const sub: Subscription = { id, runId, offset: 0, skipping: false };
    const backlog: RunLogLine[] = [];
    // Everything rendered so far, the newest lines kept.
    for (let lines = this.read(sub); lines !== null; lines = this.read(sub)) {
      backlog.push(...lines);
      if (backlog.length > RUN_LOG_BACKLOG_LINES) {
        backlog.splice(0, backlog.length - RUN_LOG_BACKLOG_LINES);
      }
    }
    for (const frame of runLogFrames(id, backlog, true))
      this.options.send(frame);
    if (isTerminalSkillRunPhase(record.phase)) {
      this.ended(id, record);
      return;
    }
    this.subs.set(id, sub);
    if (this.subs.size === 1) {
      this.cancelPoll = this.options.clock.setInterval(
        () => this.poll(),
        this.options.intervalMs ?? RUN_LOG_POLL_MS,
      );
    }
  }

  unsubscribe(id: string): void {
    if (!this.subs.delete(id)) return;
    if (this.subs.size === 0) this.cancelPoll();
  }

  /** The socket closed: subscriptions die with it, the server resubscribes. */
  reset(): void {
    this.subs.clear();
    this.cancelPoll();
  }

  stop(): void {
    this.reset();
  }

  /** Sends what each run wrote since the last poll; ends runs that are over. */
  poll(): void {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const sub of [...this.subs.values()]) {
        const record = this.options.runs.record(sub.runId);
        // Read before checking the phase, so the last lines precede `ended`.
        const lines: RunLogLine[] = [];
        for (let more = this.read(sub); more !== null; more = this.read(sub)) {
          lines.push(...more);
        }
        for (const frame of runLogFrames(sub.id, lines, false))
          this.options.send(frame);
        if (!record || isTerminalSkillRunPhase(record.phase)) {
          this.subs.delete(sub.id);
          if (record) this.ended(sub.id, record);
        }
      }
      if (this.subs.size === 0) this.cancelPoll();
    } catch (error) {
      this.options.log.warn('run log: poll failed', {
        error: errorMessage(error),
      });
    } finally {
      this.polling = false;
    }
  }

  /**
   * The next chunk of whole new lines, rendered; null when nothing complete
   * is left. A line longer than a chunk is skipped, never split.
   */
  private read(sub: Subscription): RunLogLine[] | null {
    let fd: number;
    try {
      fd = openSync(this.options.runs.streamFile(sub.runId), 'r');
    } catch {
      return null;
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= sub.offset) return null;
      const buffer = Buffer.alloc(
        Math.min(READ_CHUNK_BYTES, size - sub.offset),
      );
      const read = readSync(fd, buffer, 0, buffer.length, sub.offset);
      const chunk = buffer.subarray(0, read);
      const end = chunk.lastIndexOf(0x0a);
      if (end < 0) {
        if (read < READ_CHUNK_BYTES) return null;
        sub.offset += read;
        sub.skipping = true;
        return [];
      }
      sub.offset += end + 1;
      let text = chunk.subarray(0, end).toString('utf8');
      if (sub.skipping) {
        // Up to the first newline is the end of the overlong line.
        const first = text.indexOf('\n');
        text = first < 0 ? '' : text.slice(first + 1);
        sub.skipping = false;
      }
      return text.split('\n').flatMap(renderStreamLine);
    } finally {
      closeSync(fd);
    }
  }

  private ended(id: string, record: RunRecord): void {
    if (!isTerminalSkillRunPhase(record.phase)) return;
    this.options.send({
      type: 'run_log',
      id,
      frame: { type: 'ended', phase: record.phase },
    });
  }

  private refuse(id: string, code: SubscribeErrorMessage['code']): void {
    this.options.send({ type: 'subscribe.error', id, code });
  }
}
