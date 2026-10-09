import { afterEach, describe, expect, it } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RUN_LOG_BACKLOG_LINES,
  RUN_LOG_MAX_FRAME_BYTES,
  type RunLogMessage,
  type SkillRunPhase,
} from '@agentdock/shared/protocol';
import { FakeClock } from '../../testing/fake-clock';
import { memoryLogger, tempDir } from '../../testing/fixtures';
import { type RunLogOutbound, RunLogStreamer, runLogFrames } from './log';
import type { RunRecord } from './record';

let cleanup = () => {};
afterEach(() => cleanup());

const text = (t: string) =>
  `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })}\n`;

const setup = (phase: SkillRunPhase = 'running') => {
  const t = tempDir();
  cleanup = t.cleanup;
  const stream = join(t.dir, 'stream.jsonl');
  writeFileSync(stream, '');
  const record = { runId: 'run_1', projectId: 'prj_1', phase } as RunRecord;
  const sent: RunLogOutbound[] = [];
  const clock = new FakeClock();
  const streamer = new RunLogStreamer({
    runs: {
      record: (id) => (id === 'run_1' ? record : null),
      streamFile: () => stream,
    },
    send: (m) => {
      sent.push(m);
      return true;
    },
    clock,
    log: memoryLogger().log,
    intervalMs: 500,
  });
  const lines = (m: RunLogOutbound) =>
    m.type === 'run_log' && m.frame.type === 'lines'
      ? m.frame.lines.map((l) => l.text)
      : [];
  return { stream, record, sent, clock, streamer, lines };
};

const subscribe = {
  type: 'subscribe' as const,
  id: 's1',
  kind: 'run_log' as const,
  projectId: 'prj_1',
  runId: 'run_1',
};

describe('RunLogStreamer', () => {
  it('replays the backlog, streams new lines, then ends with the run', () => {
    const t = setup();
    appendFileSync(t.stream, text('one') + text('two'));
    t.streamer.subscribe(subscribe);
    expect(t.sent).toEqual([
      {
        type: 'run_log',
        id: 's1',
        frame: {
          type: 'lines',
          backlog: true,
          lines: [
            { kind: 'assistant', text: 'one' },
            { kind: 'assistant', text: 'two' },
          ],
        },
      },
    ]);

    // A line is sent only once it is whole.
    appendFileSync(t.stream, `${text('three')}{"type":"assist`);
    t.clock.advance(500);
    expect(t.sent.slice(1).flatMap(t.lines)).toEqual(['three']);
    expect((t.sent[1] as RunLogMessage).frame).toMatchObject({
      backlog: false,
    });
    appendFileSync(
      t.stream,
      'ant","message":{"content":[{"type":"text","text":"four"}]}}\n',
    );
    t.clock.advance(500);
    expect(t.sent.slice(2).flatMap(t.lines)).toEqual(['four']);

    appendFileSync(
      t.stream,
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.' })}\n`,
    );
    t.record.phase = 'succeeded';
    t.clock.advance(500);
    expect(t.sent.slice(-2)).toEqual([
      {
        type: 'run_log',
        id: 's1',
        frame: {
          type: 'lines',
          backlog: false,
          lines: [{ kind: 'result', text: 'Done.' }],
        },
      },
      {
        type: 'run_log',
        id: 's1',
        frame: { type: 'ended', phase: 'succeeded' },
      },
    ]);
    expect(t.streamer.subscriptionCount).toBe(0);
    expect(t.clock.pending()).toEqual([]);
  });

  it('keeps only the newest backlog lines', () => {
    const t = setup();
    let all = '';
    for (let i = 0; i < RUN_LOG_BACKLOG_LINES + 20; i++) all += text(`l${i}`);
    appendFileSync(t.stream, all);
    t.streamer.subscribe(subscribe);
    const replayed = t.sent.flatMap(t.lines);
    expect(replayed).toHaveLength(RUN_LOG_BACKLOG_LINES);
    expect(replayed[0]).toBe('l20');
  });

  it('answers a finished run with its backlog and ended at once', () => {
    const t = setup('cancelled');
    appendFileSync(t.stream, text('one'));
    t.streamer.subscribe(subscribe);
    expect(
      t.sent.map((m) => (m.type === 'run_log' ? m.frame.type : m.type)),
    ).toEqual(['lines', 'ended']);
    expect(t.streamer.subscriptionCount).toBe(0);
  });

  it('refuses a run of another project or an unknown run as not_found', () => {
    const t = setup();
    t.streamer.subscribe({ ...subscribe, projectId: 'prj_2' });
    t.streamer.subscribe({ ...subscribe, id: 's2', runId: 'run_9' });
    expect(t.sent).toEqual([
      { type: 'subscribe.error', id: 's1', code: 'not_found' },
      { type: 'subscribe.error', id: 's2', code: 'not_found' },
    ]);
  });

  it('stops tailing on unsubscribe and on reset', () => {
    const t = setup();
    t.streamer.subscribe(subscribe);
    t.streamer.unsubscribe('s1');
    expect(t.clock.pending()).toEqual([]);
    t.streamer.subscribe(subscribe);
    t.streamer.reset();
    appendFileSync(t.stream, text('late'));
    t.clock.advance(5000);
    expect(t.sent.flatMap(t.lines)).toEqual([]);
  });
});

describe('runLogFrames', () => {
  it('splits under the frame cap', () => {
    const lines = Array.from({ length: 60 }, () => ({
      kind: 'assistant' as const,
      text: 'x'.repeat(3900),
    }));
    const frames = runLogFrames('s1', lines, true);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      expect(Buffer.byteLength(JSON.stringify(f))).toBeLessThanOrEqual(
        RUN_LOG_MAX_FRAME_BYTES,
      );
    }
    expect(
      frames.flatMap((f) => (f.frame.type === 'lines' ? f.frame.lines : [])),
    ).toHaveLength(60);
  });
});
