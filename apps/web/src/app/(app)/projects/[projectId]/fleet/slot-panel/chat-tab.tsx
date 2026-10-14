'use client';

import type { SlotConversation } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { ChatThread } from '@andrewbehma/glass-ui/chat-thread';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { Markdown } from '../../../../../../components/markdown/markdown';
import { AsyncSection } from '../../../../../../components/prerequisites/async-section';
import {
  MESSAGE_MAX_BYTES,
  messageProblem,
} from '../../../../../../lib/control/format';
import type { useControl } from '../../../../../../lib/control/use-control';
import { CHECKPOINT_TONE } from '../../../../../../lib/fleet/format';
import { pluralize } from '../../../../../../lib/format';
import type { Section } from '../../../../../../lib/section/use-section';
import {
  chatMessages,
  messageOutcome,
  OUTBOX_STATE_LABEL,
  type SlotChatMessage,
} from '../../../../../../lib/slot/format';
import { outboxReducer } from '../../../../../../lib/slot/outbox';

/** How often a `sent` entry is checked against its TTL when nothing arrives. */
const RECONCILE_TICK_MS = 15_000;

/**
 * The orchestrator ↔ worker thread (#160): the orchestrator's messages and
 * the worker's reply sections, oldest first, then what this tab sent and has
 * not seen come back. The composer sends "message worker" (spec 17 D7).
 */
export function ChatTab({
  slot,
  conversation,
  control,
  writeReason,
}: {
  slot: string;
  conversation: Section<SlotConversation>;
  control: ReturnType<typeof useControl>;
  /** Why this person cannot message the worker now; undefined when they can. */
  writeReason: string | undefined;
}) {
  const [outbox, dispatch] = useReducer(outboxReducer, []);
  const [draft, setDraft] = useState('');
  const entries = conversation.data?.entries;

  useEffect(() => {
    const reconcile = () =>
      dispatch({ type: 'reconcile', entries: entries ?? [], now: Date.now() });
    reconcile();
    const id = setInterval(reconcile, RECONCILE_TICK_MS);
    return () => clearInterval(id);
  }, [entries]);

  const deliver = async (id: string, text: string) => {
    const outcome = messageOutcome(await control.message(slot, text));
    dispatch(
      outcome.ok
        ? { type: 'ack', id }
        : { type: 'fail', id, error: outcome.error },
    );
  };

  const send = (value: string) => {
    if (messageProblem(value) !== null) return;
    const id = crypto.randomUUID();
    dispatch({ type: 'send', id, text: value, at: new Date().toISOString() });
    // The text lives in the outbox now; a failure keeps it there to retry.
    setDraft('');
    void deliver(id, value);
  };

  const retry = (id: string, text: string) => {
    dispatch({ type: 'retry', id, at: new Date().toISOString() });
    void deliver(id, text);
  };

  const messages = useMemo(
    () => chatMessages(entries ?? [], outbox, slot),
    [entries, outbox, slot],
  );
  const byId = useMemo(
    () => new Map(messages.map((m) => [m.id, m])),
    [messages],
  );

  const tooLong = messageProblem(draft) === 'too_long';

  const renderBody = (message: SlotChatMessage) => {
    const outboxEntry = message.outbox;
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        {message.checkpoint && message.checkpointKind ? (
          <span>
            <Badge
              tone={CHECKPOINT_TONE[message.checkpointKind]}
              label={message.checkpoint}
            />
          </span>
        ) : null}
        <Markdown compact>{message.body}</Markdown>
        {outboxEntry ? (
          <div
            className={`flex flex-wrap items-center gap-2 text-xs ${
              outboxEntry.state === 'failed' ? 'text-danger' : 'text-ink-3'
            }`}
            role={outboxEntry.state === 'failed' ? 'alert' : 'status'}
          >
            <span>
              {OUTBOX_STATE_LABEL[outboxEntry.state]}
              {outboxEntry.error ? ` ${outboxEntry.error}` : ''}
            </span>
            {outboxEntry.state === 'failed' ? (
              <>
                <Button
                  variant="glass"
                  size="sm"
                  disabled={writeReason !== undefined}
                  onClick={() => retry(outboxEntry.id, outboxEntry.text)}
                >
                  Retry
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    dispatch({ type: 'discard', id: outboxEntry.id })
                  }
                >
                  Discard
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const truncated = conversation.data?.truncated ?? 0;

  return (
    <AsyncSection
      section={conversation}
      unavailable={{
        title: 'The conversation could not be loaded',
        stillWorks: 'The other tabs still work.',
      }}
      empty={null}
      isEmpty={() => false}
      skeleton={<Skeleton className="h-96 w-full" />}
    >
      {() => (
        <div className="flex min-h-0 flex-col gap-2">
          {truncated > 0 ? (
            <p className="text-xs text-ink-3">
              {pluralize(truncated, 'earlier entry', 'earlier entries')} not
              shown.
            </p>
          ) : null}
          <ChatThread
            className="h-[60vh] max-h-[40rem] min-h-80"
            messages={messages}
            renderBody={(m) => {
              const message = byId.get(m.id);
              return message ? renderBody(message) : null;
            }}
            labels={{ log: `Conversation with ${slot}` }}
            empty={
              <p className="p-4 text-sm text-ink-2">
                Nothing yet. The worker’s checkpoints and the orchestrator’s
                messages appear here as the runner sees them.
              </p>
            }
            composer={{
              'aria-label': `Message ${slot}`,
              placeholder: 'Message the worker…',
              layout: 'stacked',
              value: draft,
              onValueChange: setDraft,
              onSubmit: send,
              disabled: writeReason !== undefined,
              disabledReason: writeReason,
              sendLabel: 'Send message',
            }}
          />
          {tooLong ? (
            <p role="alert" className="text-xs text-danger">
              Over the {MESSAGE_MAX_BYTES / 1024} KB limit.
            </p>
          ) : null}
          <p className="text-xs text-ink-3">
            The orchestrator normally speaks to workers. A message sent from
            here bypasses it, so it will not know what was said until it reads
            the board.
          </p>
        </div>
      )}
    </AsyncSection>
  );
}
