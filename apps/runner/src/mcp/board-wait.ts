import {
  BOARD_WAIT_TIMEOUT_MAX_SEC,
  LOCAL_BOARD_WAIT_HOLD_MAX_SEC,
  localBoardWaitResultSchema,
} from '@nautelle/shared/protocol';
import type { z } from 'zod';
import type { LocalResult } from '../local/types';

type LocalBoardWaitResult = z.infer<typeof localBoardWaitResultSchema>;

/** Asks the daemon one local method; the same shape as `McpRequest`. */
type Ask = (
  method: 'board.wait',
  args: Record<string, unknown>,
) => Promise<LocalResult<unknown>>;

export interface BoardWaitClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: BoardWaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A server answer faster than this with nothing in it is not a hold. */
const FAST_ANSWER_MS = 250;
const FAST_ANSWER_PAUSE_MS = 1_000;

/**
 * `board_wait` (#845 D8): the server holds one `board.wait` for at most
 * `LOCAL_BOARD_WAIT_HOLD_MAX_SEC` — under the local request timeout — so the
 * tool loops it, each call from the cursor the last returned, until events
 * arrive or `timeoutSec` (≤ `BOARD_WAIT_TIMEOUT_MAX_SEC`) passes. At the cap
 * it answers empty with the latest cursor, never an error. A first call
 * without a cursor is answered at once by the server with a cursor to start
 * from; the loop then waits from it.
 */
export const boardWait = async (
  ask: Ask,
  input: { cursor?: string; cards?: number[]; timeoutSec?: number },
  clock: BoardWaitClock = realClock,
): Promise<LocalResult<LocalBoardWaitResult>> => {
  const total = Math.min(
    input.timeoutSec ?? BOARD_WAIT_TIMEOUT_MAX_SEC,
    BOARD_WAIT_TIMEOUT_MAX_SEC,
  );
  const deadline = clock.now() + total * 1_000;
  let cursor = input.cursor;
  for (;;) {
    const remainingSec = Math.max(
      0,
      Math.ceil((deadline - clock.now()) / 1_000),
    );
    const startedAt = clock.now();
    const answer = await ask('board.wait', {
      ...(cursor ? { cursor } : {}),
      ...(input.cards ? { cards: input.cards } : {}),
      timeoutSec: Math.min(remainingSec, LOCAL_BOARD_WAIT_HOLD_MAX_SEC),
    });
    if (!answer.ok) return answer;
    const parsed = localBoardWaitResultSchema.safeParse(answer.data);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'internal',
          message: 'board.wait answered something this runner does not know',
        },
      };
    }
    const { events } = parsed.data;
    cursor = parsed.data.cursor;
    if (events.length > 0) return { ok: true, data: { events, cursor } };
    const left = deadline - clock.now();
    if (left <= 0) return { ok: true, data: { events: [], cursor } };
    // A server that answers at once (an unknown cursor, a fresh start) would
    // otherwise be asked in a tight loop.
    if (clock.now() - startedAt < FAST_ANSWER_MS) {
      await clock.sleep(Math.min(FAST_ANSWER_PAUSE_MS, left));
      if (deadline - clock.now() <= 0)
        return { ok: true, data: { events: [], cursor } };
    }
  }
};
