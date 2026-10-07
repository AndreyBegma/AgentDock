import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SPOOL_TRUNCATED_EVENT,
  spoolTruncatedDataSchema,
} from '@agentdock/shared/protocol';
import { Spool } from './spool';
import { memoryLogger, tempDir, testEvent } from './testing/fixtures';

describe('Spool', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  const open = (options: { segmentBytes?: number; capBytes?: number } = {}) =>
    Spool.open({ dir, log: memoryLogger().log, ...options });
  const seqs = (spool: Spool, after = 0) =>
    [...spool.eventsAfter(after)].map((e) => e.seq);
  const segments = () => readdirSync(dir).filter((f) => f.endsWith('.jsonl'));

  it('assigns seq from 1 and reads back everything above a cursor', () => {
    const spool = open();
    for (let n = 1; n <= 5; n++) spool.append(testEvent(n));
    expect(seqs(spool)).toEqual([1, 2, 3, 4, 5]);
    expect(seqs(spool, 3)).toEqual([4, 5]);
  });

  it('continues seq after a restart', () => {
    const first = open();
    first.append(testEvent(1));
    first.append(testEvent(2));
    const second = open();
    expect(second.append(testEvent(3))[0].seq).toBe(3);
    expect(seqs(second)).toEqual([1, 2, 3]);
  });

  it('continues seq after a restart even when every segment was acked and deleted', () => {
    const first = open();
    first.append(testEvent(1));
    first.append(testEvent(2));
    first.ack(2);
    expect(segments()).toEqual([]);
    const second = open();
    expect(second.ackedSeq).toBe(2);
    expect(second.append(testEvent(3))[0].seq).toBe(3);
  });

  it('deletes acked segments, keeps the active one until it is fully acked', () => {
    const spool = open({ segmentBytes: 200 });
    for (let n = 1; n <= 6; n++) spool.append(testEvent(n));
    const before = segments().length;
    expect(before).toBeGreaterThan(2);
    spool.ack(4);
    expect(segments().length).toBeLessThan(before);
    expect(seqs(spool, 4)).toEqual([5, 6]);
    expect(Math.min(...seqs(spool))).toBeLessThanOrEqual(5);
    spool.ack(6);
    expect(segments()).toEqual([]);
    expect(spool.ackedSeq).toBe(6);
  });

  it('drops the oldest segment over the cap and emits runner.spool_truncated', () => {
    const spool = open({ segmentBytes: 200, capBytes: 600 });
    const appended = [];
    for (let n = 1; n <= 20; n++) appended.push(...spool.append(testEvent(n)));
    const truncations = appended.filter(
      (e) => e.type === SPOOL_TRUNCATED_EVENT,
    );
    expect(truncations.length).toBeGreaterThan(0);
    const first = spoolTruncatedDataSchema.parse(truncations[0].data);
    expect(first.fromSeq).toBe(1);
    expect(first.toSeq).toBeGreaterThanOrEqual(first.fromSeq);
    expect(first.bytes).toBeGreaterThan(0);
    expect(truncations[0].source).toBe('runner');
    expect(spool.stats().bytes).toBeLessThanOrEqual(600 + 200);

    // What remains is contiguous and ends at the last seq.
    const left = seqs(spool);
    expect(left.at(-1)).toBe(spool.lastSeq);
    expect(left).toEqual(
      Array.from({ length: left.length }, (_, i) => left[0] + i),
    );
  });

  it('reports only the unacked part of a dropped segment', () => {
    const spool = open({ segmentBytes: 200, capBytes: 600 });
    spool.append(testEvent(1));
    spool.append(testEvent(2));
    spool.ack(1);
    const appended = [];
    for (let n = 3; n <= 20; n++) appended.push(...spool.append(testEvent(n)));
    const truncation = appended.find((e) => e.type === SPOOL_TRUNCATED_EVENT);
    expect(spoolTruncatedDataSchema.parse(truncation?.data).fromSeq).toBe(2);
  });

  it('cuts a torn last line left by a crash and carries on', () => {
    const spool = open();
    spool.append(testEvent(1));
    const [segment] = segments();
    appendFileSync(join(dir, segment), '{"v":1,"seq":2,"ts":');
    const reopened = open();
    expect(reopened.lastSeq).toBe(1);
    expect(reopened.append(testEvent(2))[0].seq).toBe(2);
    expect(seqs(reopened)).toEqual([1, 2]);
  });

  it('inspects without opening for writing', () => {
    const spool = open();
    spool.append(testEvent(1));
    spool.append(testEvent(2));
    expect(Spool.inspect(dir)).toMatchObject({
      segments: 1,
      lastSeq: 2,
      ackedSeq: 0,
    });
    expect(Spool.inspect(join(dir, 'missing'))).toEqual({
      segments: 0,
      bytes: 0,
      lastSeq: 0,
      ackedSeq: 0,
    });
  });
});
