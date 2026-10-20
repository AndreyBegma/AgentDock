import type { ConversationEntry } from '@agentdock/shared';

/**
 * The chat's optimistic messages: what this tab sent to the worker and has
 * not yet seen come back in the conversation.
 *
 * - `sending` — the POST is in flight;
 * - `sent` — the runner wrote `.orchestrator-msg.md`; the entry waits for the
 *   watcher's `slot.message_seen` to show it in the conversation;
 * - `failed` — the command failed or never answered; it stays, with Retry
 *   and Discard, until the person picks one.
 */
export type OutboxState = 'sending' | 'sent' | 'failed';

export interface OutboxEntry {
  id: string;
  text: string;
  /** When it was (last) sent, ISO. */
  at: string;
  state: OutboxState;
  /** Why it failed; only on `failed`. */
  error?: string;
}

export type OutboxAction =
  | { type: 'send'; id: string; text: string; at: string }
  | { type: 'ack'; id: string }
  | { type: 'fail'; id: string; error: string }
  | { type: 'retry'; id: string; at: string }
  | { type: 'discard'; id: string }
  | { type: 'reconcile'; entries: readonly ConversationEntry[]; now: number };

/**
 * A `sent` entry is dropped after this long even if the conversation never
 * showed it (a runner without the message watcher), so it cannot stick.
 */
export const OUTBOX_SENT_TTL_MS = 2 * 60_000;

/** Clocks of the browser and the runner differ; a match may be this much early. */
export const OUTBOX_CLOCK_SKEW_MS = 60_000;

/**
 * Whether the conversation already shows `entry`: an orchestrator message,
 * seen no earlier than it was sent (less the skew), whose body carries the
 * text. Nautelle's own message file adds a `From:` / `Date:` header, so the
 * body contains the text rather than equals it.
 */
export function isDelivered(
  entry: Pick<OutboxEntry, 'text' | 'at'>,
  conversation: readonly ConversationEntry[],
): boolean {
  const text = entry.text.trim();
  const since = Date.parse(entry.at) - OUTBOX_CLOCK_SKEW_MS;
  return conversation.some(
    (c) =>
      c.from === 'orchestrator' &&
      Date.parse(c.at) >= since &&
      c.body.includes(text),
  );
}

export function outboxReducer(
  state: readonly OutboxEntry[],
  action: OutboxAction,
): OutboxEntry[] {
  const update = (id: string, change: (entry: OutboxEntry) => OutboxEntry) =>
    state.map((entry) => (entry.id === id ? change(entry) : entry));

  switch (action.type) {
    case 'send':
      return [
        ...state,
        { id: action.id, text: action.text, at: action.at, state: 'sending' },
      ];
    case 'ack':
      return update(action.id, ({ error: _, ...entry }) => ({
        ...entry,
        state: 'sent',
      }));
    case 'fail':
      return update(action.id, (entry) => ({
        ...entry,
        state: 'failed',
        error: action.error,
      }));
    case 'retry':
      return update(action.id, ({ error: _, ...entry }) => ({
        ...entry,
        at: action.at,
        state: 'sending',
      }));
    case 'discard':
      return state.filter((entry) => entry.id !== action.id);
    case 'reconcile':
      // Only `sent` entries leave on their own: one in flight has nothing to
      // match yet, and a failure waits for the person.
      return state.filter(
        (entry) =>
          entry.state !== 'sent' ||
          (!isDelivered(entry, action.entries) &&
            action.now - Date.parse(entry.at) < OUTBOX_SENT_TTL_MS),
      );
  }
}
