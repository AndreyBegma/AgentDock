'use client';

import type { PlanAnswer, PlanQuestion, PlanTurnView } from '@agentdock/shared';
import { ChatThread } from '@andrewbehma/glass-ui/chat-thread';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import { PromptInput } from '@andrewbehma/glass-ui/prompt-input';
import { useState } from 'react';
import { formatDate, pluralize } from '../../lib/format';
import { roundKey } from '../../lib/planner/answers';
import { isActiveTurn, turnBody } from '../../lib/planner/format';
import type { PastRound as PastRoundData } from '../../lib/planner/rounds';
import { FailedTurn } from './failed-turn';
import { PastRound } from './past-round';
import { QuestionRound } from './question-round';
import { RunningTurn } from './running-turn';

/**
 * A conversation with the planner — the plan's (dialogue mode) or one
 * task's (the grill): earlier turns collapsed into chat entries, earlier
 * rounds as read-only cards with their answers, the turn in flight or the one
 * that failed, the open round's question cards, and a chat composer below.
 * Every round and every message is one turn.
 */
export function Conversation({
  label,
  turns,
  rounds,
  questions,
  active,
  failed,
  canWrite,
  writeReason,
  busy,
  chat = true,
  onAnswers,
  onMessage,
  onCancel,
  onRetry,
}: {
  /** Names the composer: "Message the planner about t3". */
  label: string;
  /** This scope's turns, oldest first. */
  turns: readonly PlanTurnView[];
  /** Earlier rounds, read-only, oldest first (#184). */
  rounds: readonly PastRoundData[];
  /** The open round, interactive. */
  questions: readonly PlanQuestion[];
  /** The plan's turn in flight, if it belongs to this scope. */
  active: PlanTurnView | null;
  failed: PlanTurnView | null;
  canWrite: boolean;
  /** Why a write is off: a turn elsewhere in the plan, a closed plan, a viewer. */
  writeReason?: string;
  busy: 'cancel' | 'retry' | null;
  /**
   * The chat composer. Off for the plan once it has tasks: from then on the
   * plan speaks through reviews and Revise plan, and only its turn in flight
   * or the one that failed is shown here.
   */
  chat?: boolean;
  onAnswers: (answers: PlanAnswer[]) => Promise<void>;
  onMessage: (message: string) => Promise<void>;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const earlier = turns.filter((t) => !isActiveTurn(t) && t.id !== failed?.id);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message) return;
    try {
      await onMessage(message);
      setDraft('');
    } catch {
      // The caller said why; the draft stays.
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {earlier.length > 0 ? (
        <Disclosure
          open={open}
          onOpenChange={setOpen}
          trigger={`${open ? 'Hide' : 'Show'} earlier turns (${pluralize(earlier.length, 'turn')})`}
          triggerClassName="text-sm text-accent-ink underline underline-offset-2"
        >
          <ChatThread
            className="mt-2 max-h-96"
            composer={null}
            messages={earlier.map((t) => ({
              id: t.id,
              author: t.author.name,
              time: formatDate(t.createdAt, 'datetime'),
              dateTime: t.createdAt,
              body: turnBody(t),
            }))}
            renderBody={(m) => (
              <p className="text-sm whitespace-pre-line break-words">
                {m.body}
              </p>
            )}
          />
        </Disclosure>
      ) : null}

      {/* A turn opens at most one round per scope, so it keys the round. */}
      {rounds.map((round, i) => (
        <PastRound key={round.openedBy.id} round={round} number={i + 1} />
      ))}

      {active ? (
        <RunningTurn
          turn={active}
          canCancel={canWrite}
          cancelling={busy === 'cancel'}
          onCancel={onCancel}
        />
      ) : failed ? (
        <FailedTurn
          turn={failed}
          canRetry={canWrite}
          retrying={busy === 'retry'}
          onRetry={onRetry}
        />
      ) : null}

      {questions.length > 0 && rounds.length > 0 ? (
        <h3 className="text-sm font-semibold text-ink">
          Round {rounds.length + 1}
        </h3>
      ) : null}
      {questions.length > 0 ? (
        <QuestionRound
          key={roundKey(questions)}
          questions={questions}
          disabled={!canWrite || active !== null}
          disabledReason={
            active ? 'Wait for the planner to answer.' : writeReason
          }
          onSubmit={onAnswers}
        />
      ) : null}

      {chat ? (
        <PromptInput
          aria-label={label}
          placeholder="Tell the planner something…"
          multiline
          value={draft}
          onValueChange={setDraft}
          onSubmit={(text) => void send(text)}
          disabled={!canWrite || active !== null}
          disabledReason={
            active
              ? 'Wait for the planner to answer.'
              : (writeReason ?? undefined)
          }
          sendLabel="Send"
        />
      ) : null}
    </div>
  );
}
