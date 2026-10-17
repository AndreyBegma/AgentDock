import { describe, expect, test } from 'bun:test';
import type { AssistantMessageView } from '@agentdock/shared';
import { applyEvent, startTurn } from './turn';

describe('applyEvent', () => {
  test('appends deltas token by token', () => {
    let outcome = applyEvent(startTurn('hi'), { type: 'delta', text: 'Hel' });
    outcome = applyEvent(outcome.turn, { type: 'delta', text: 'lo' });
    expect(outcome.kind).toBe('streaming');
    expect(outcome.turn.reply).toBe('Hello');
  });

  test('a tool runs, then finishes in place', () => {
    let { turn } = applyEvent(startTurn('x'), {
      type: 'tool',
      id: 't1',
      name: 'read_queue',
      status: 'started',
    });
    expect(turn.tools).toEqual([
      { id: 't1', name: 'read_queue', status: 'running' },
    ]);
    ({ turn } = applyEvent(turn, {
      type: 'tool',
      id: 't1',
      name: 'read_queue',
      status: 'done',
      ok: true,
      summary: 'Read queue — 14 ready',
    }));
    expect(turn.tools).toHaveLength(1);
    expect(turn.tools[0]).toMatchObject({ status: 'done', ok: true });
  });

  test('a finished tool that never started is still listed', () => {
    const { turn } = applyEvent(startTurn('x'), {
      type: 'tool',
      id: 't9',
      name: 'queue_card',
      status: 'done',
      ok: true,
      summary: 'Queued C-5',
    });
    expect(turn.tools).toHaveLength(1);
  });

  test('keeps the project and the title', () => {
    let { turn } = applyEvent(startTurn('x'), {
      type: 'project',
      projectId: 'p',
      projectName: 'Alpha',
    });
    ({ turn } = applyEvent(turn, { type: 'title', title: 'Queue status' }));
    expect(turn.projectName).toBe('Alpha');
    expect(turn.title).toBe('Queue status');
  });

  test('done and error end the turn', () => {
    const message = { id: 'm' } as AssistantMessageView;
    const done = applyEvent(startTurn('x'), {
      type: 'done',
      userMessage: message,
      message,
    });
    expect(done.kind).toBe('done');
    const error = applyEvent(startTurn('x'), {
      type: 'error',
      code: 'llm_cap_reached',
      message: 'cap',
    });
    expect(error.kind).toBe('error');
  });
});
