import { describe, expect, it } from 'bun:test';
import {
  chunkResultText,
  isPlanTurnEventType,
  jsonStringBytes,
  PLAN_TURN_EVENT_TYPES,
  PLAN_TURN_RESULT_CHUNK_BYTES,
  PLAN_TURN_RESULT_MAX_BYTES,
  planTurnFinishedDataSchema,
  planTurnPhaseChangedDataSchema,
  planTurnResultChunkDataSchema,
} from '../index';

const ref = {
  planId: 'cmplan0001',
  turnId: 'cmturn0001',
  runId: 'cmrun0001',
  projectId: 'prj_1',
};
const at = '2026-11-07T10:00:00.000Z';

describe('plan turn events', () => {
  it('are the three types', () => {
    expect(PLAN_TURN_EVENT_TYPES).toEqual([
      'plan_turn.phase_changed',
      'plan_turn.result_chunk',
      'plan_turn.finished',
    ]);
    expect(isPlanTurnEventType('plan_turn.finished')).toBe(true);
    expect(isPlanTurnEventType('skill_run.finished')).toBe(false);
  });

  it('phase_changed carries every phase', () => {
    for (const phase of ['queued', 'running', 'succeeded', 'failed']) {
      expect(
        planTurnPhaseChangedDataSchema.safeParse({ ...ref, phase, at }).success,
      ).toBe(true);
    }
    expect(
      planTurnPhaseChangedDataSchema.safeParse({ ...ref, phase: 'x', at })
        .success,
    ).toBe(false);
  });

  it('finished carries the result text, the session id and the exit code', () => {
    const finished = {
      ...ref,
      phase: 'succeeded',
      at,
      sessionId: '1e2d3c4b-5a69-4788-9a6b-5c4d3e2f1a0b',
      exitCode: 0,
      resultText: '```agentdock-plan\n{}\n```',
      resultTruncated: false,
    };
    expect(planTurnFinishedDataSchema.safeParse(finished).success).toBe(true);
    expect(
      planTurnFinishedDataSchema.safeParse({ ...finished, phase: 'running' })
        .success,
    ).toBe(false);
    expect(
      planTurnFinishedDataSchema.safeParse({
        ...finished,
        resultText: 'a'.repeat(PLAN_TURN_RESULT_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
  });

  it('a failed turn may have no result', () => {
    expect(
      planTurnFinishedDataSchema.safeParse({
        ...ref,
        phase: 'failed',
        at,
        resultTruncated: false,
        error: 'timeout',
      }).success,
    ).toBe(true);
  });

  it('#686: finished names its chunks, never beside the text', () => {
    const finished = {
      ...ref,
      phase: 'succeeded',
      at,
      resultTruncated: false,
      resultChunks: 3,
    };
    expect(planTurnFinishedDataSchema.safeParse(finished).success).toBe(true);
    expect(
      planTurnFinishedDataSchema.safeParse({ ...finished, resultText: 'x' })
        .success,
    ).toBe(false);
    expect(
      planTurnFinishedDataSchema.safeParse({ ...finished, resultChunks: 0 })
        .success,
    ).toBe(false);
  });

  it('#686: a chunk holds at most one chunk of text', () => {
    const chunk = { ...ref, index: 0, text: 'abc' };
    expect(planTurnResultChunkDataSchema.safeParse(chunk).success).toBe(true);
    expect(
      planTurnResultChunkDataSchema.safeParse({
        ...chunk,
        text: 'a'.repeat(PLAN_TURN_RESULT_CHUNK_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      planTurnResultChunkDataSchema.safeParse({ ...chunk, index: -1 }).success,
    ).toBe(false);
  });
});

describe('chunkResultText', () => {
  it('splits by the JSON-encoded size and joins back whole', () => {
    const text =
      `${'"'.repeat(150)}${'é'.repeat(100)}${'😀'.repeat(80)}\n`.repeat(40);
    const chunks = chunkResultText(text, 1000);
    expect(chunks.join('')).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(jsonStringBytes(chunk)).toBeLessThanOrEqual(1000);
      // Never a lone surrogate at either end.
      expect(chunk).toBe(JSON.parse(JSON.stringify(chunk)));
      expect(new TextDecoder().decode(new TextEncoder().encode(chunk))).toBe(
        chunk,
      );
    }
  });

  it('keeps a small text in one chunk and an empty one in none', () => {
    expect(chunkResultText('abc')).toEqual(['abc']);
    expect(chunkResultText('')).toEqual([]);
  });

  it('cuts a large result into chunk-sized events', () => {
    const chunks = chunkResultText('a'.repeat(175 * 1024 * 2));
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBe(PLAN_TURN_RESULT_CHUNK_BYTES);
  });
});
