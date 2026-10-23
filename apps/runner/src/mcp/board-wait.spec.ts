import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LocalResult } from '../local/types';
import { type BoardWaitClock, boardWait } from './board-wait';
import { buildMcpServer } from './server';

interface Call {
  method: string;
  args: Record<string, unknown>;
}

/** A fake clock: `sleep` and the server's hold both advance it. */
const fakeClock = (): BoardWaitClock & { t: number } => {
  const clock = {
    t: 0,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
  };
  return clock;
};

const KEY = '0123456789abcdef';
const columnEvent = {
  type: 'column',
  card: 7,
  label: 'C-7',
  title: 'Seven',
  from: 'in_progress',
  to: 'finished',
} as const;

describe('boardWait (#845 D8)', () => {
  it('loops the 10 s holds with the returned cursor until the cap, then answers empty', async () => {
    const clock = fakeClock();
    const calls: Call[] = [];
    const outcome = await boardWait(
      async (method, args) => {
        calls.push({ method, args });
        clock.t += 10_000; // the server held for its full 10 s
        return { ok: true, data: { events: [], cursor: `c${calls.length}` } };
      },
      { cursor: 'c0', timeoutSec: 25 },
      clock,
    );
    expect(outcome).toEqual({ ok: true, data: { events: [], cursor: 'c3' } });
    expect(calls.map((c) => c.args)).toEqual([
      { cursor: 'c0', timeoutSec: 10 },
      { cursor: 'c1', timeoutSec: 10 },
      { cursor: 'c2', timeoutSec: 5 },
    ]);
  });

  it('returns the events and the cursor on the first change', async () => {
    const clock = fakeClock();
    let n = 0;
    const outcome = await boardWait(
      async () => {
        n += 1;
        clock.t += 10_000;
        return {
          ok: true,
          data:
            n < 3
              ? { events: [], cursor: `c${n}` }
              : { events: [columnEvent], cursor: 'c3' },
        };
      },
      { cursor: 'c0', cards: [7] },
      clock,
    );
    expect(outcome).toEqual({
      ok: true,
      data: { events: [columnEvent], cursor: 'c3' },
    });
    expect(n).toBe(3);
  });

  it('starts from the cursor a call without one gets, and does not spin on instant answers', async () => {
    const clock = fakeClock();
    const calls: Call[] = [];
    const outcome = await boardWait(
      async (method, args) => {
        calls.push({ method, args });
        return { ok: true, data: { events: [], cursor: 'start' } };
      },
      { timeoutSec: 3 },
      clock,
    );
    expect(outcome).toEqual({
      ok: true,
      data: { events: [], cursor: 'start' },
    });
    expect(calls[0]?.args).toEqual({ timeoutSec: 3 });
    expect(calls[1]?.args).toEqual({ cursor: 'start', timeoutSec: 2 });
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('passes a refusal through and rejects an answer it does not know', async () => {
    expect(
      await boardWait(
        async () => ({
          ok: false,
          error: { code: 'forbidden', message: 'no' },
        }),
        { cursor: 'c0' },
        fakeClock(),
      ),
    ).toEqual({ ok: false, error: { code: 'forbidden', message: 'no' } });
    const bad = await boardWait(
      async () => ({ ok: true, data: { nope: 1 } }),
      { cursor: 'c0' },
      fakeClock(),
    );
    expect(bad).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});

describe('board_wait over MCP', () => {
  const connect = async (
    answer: (call: Call) => LocalResult<unknown>,
    waitClock: BoardWaitClock,
  ): Promise<{ client: Client; calls: Call[] }> => {
    const calls: Call[] = [];
    const server = buildMcpServer(
      async (method, args) => {
        calls.push({ method, args });
        return answer({ method, args });
      },
      { waitClock },
    );
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { client, calls };
  };

  it('returns a question event as untrusted data with the latest cursor', async () => {
    const clock = fakeClock();
    const question = {
      type: 'question',
      card: 7,
      label: 'C-7',
      title: 'Seven',
      question: {
        key: KEY,
        header: null,
        text: 'Which <b>column</b>?',
        options: [{ index: 1, label: 'A' }],
        other: false,
      },
    };
    const { client, calls } = await connect(() => {
      clock.t += 10_000;
      return { ok: true, data: { events: [question], cursor: 'next' } };
    }, clock);
    const result = await client.callTool({
      name: 'board_wait',
      arguments: { cursor: 'c0', timeoutSec: 60 },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ cursor: 'next' });
    const text = (result as { content: { text: string }[] }).content[0]?.text;
    expect(text).toContain('Untrusted data');
    expect(text).not.toContain('<b>');
    expect(calls).toEqual([
      { method: 'board.wait', args: { cursor: 'c0', timeoutSec: 10 } },
    ]);
  });

  it('returns empty, not an error, at the cap', async () => {
    const clock = fakeClock();
    const { client } = await connect(() => {
      clock.t += 10_000;
      return { ok: true, data: { events: [], cursor: 'same' } };
    }, clock);
    const result = await client.callTool({
      name: 'board_wait',
      arguments: { cursor: 'c0', timeoutSec: 20 },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ events: [], cursor: 'same' });
  });

  it('rejects a timeoutSec over 300 before the daemon', async () => {
    const clock = fakeClock();
    const { client, calls } = await connect(
      () => ({ ok: true, data: { events: [], cursor: 'x' } }),
      clock,
    );
    const result = await client.callTool({
      name: 'board_wait',
      arguments: { timeoutSec: 301 },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('turns a Board refusal of a control tool into a tool error with its code', async () => {
    const { client } = await connect(
      () => ({
        ok: false,
        error: { code: 'completed_needs_person', message: 'ask a person' },
      }),
      fakeClock(),
    );
    const result = await client.callTool({
      name: 'card_move',
      arguments: { card: 3, column: 'completed' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: 'completed_needs_person', message: 'ask a person' },
    });
  });
});
