'use client';

import {
  BOARD_ERROR,
  type BoardCardView,
  type BoardStackDetail,
  COLUMN_TITLE,
  STACK_BODY_MAX,
  STACK_TITLE_MAX,
} from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Input, Textarea } from '@andrewbehma/glass-ui/field';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { createStack } from '../../lib/board/actions';
import { describeBoardError } from '../../lib/board/format';
import { cardCountText, planGroup } from '../../lib/board/stacks';

/** A 409 `stack_refused`: the cards it named and why, as the server said it. */
export interface GroupRefusal {
  cards: number[];
  message: string;
}

/** The refusal a 409 of `POST …/board/stacks` carries; null for any other error. */
export const groupRefusalOf = (error: unknown): GroupRefusal | null => {
  if (
    !(error instanceof ApiError) ||
    error.status !== 409 ||
    error.body?.error !== BOARD_ERROR.stackRefused
  ) {
    return null;
  }
  const cards = Array.isArray(error.body.cards)
    ? error.body.cards.filter((n): n is number => typeof n === 'number')
    : [];
  return { cards, message: error.message };
};

/**
 * #588: Group into stack — the selected cards that can join become one new
 * stack of a single stage, each still running on its own. A title is
 * required; the description is optional; the shared design is off unless
 * turned on, and then holds Run until it is approved (ADR-0044 §4, §6).
 * A refusal keeps what was typed and leaves out the cards it named.
 */
export function GroupStackDialog({
  projectId,
  cards,
  open,
  onOpenChange,
  onGrouped,
}: {
  projectId: string;
  /** The selection. */
  cards: readonly BoardCardView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGrouped: (stack: BoardStackDetail) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [design, setDesign] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<GroupRefusal>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) return;
    setTitle('');
    setBody('');
    setDesign(false);
    setRefusal(undefined);
    setError(undefined);
  }, [open]);

  const plan = planGroup(cards, new Set(refusal?.cards ?? []));
  const n = plan.joins.length;
  const valid = title.trim() !== '' && plan.ready && !busy;
  // What the bar already left out; a card the server refused is in the danger banner.
  const leftOut = plan.left.filter(
    (l) => !refusal?.cards.includes(l.card.number),
  );

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    try {
      const stack = await createStack(projectId, {
        title: title.trim(),
        ...(body.trim() ? { body } : {}),
        design,
        cards: plan.joins.map((c) => c.number),
      });
      onGrouped(stack);
    } catch (err) {
      const refused = groupRefusalOf(err);
      if (refused) {
        setRefusal({
          cards: [...new Set([...(refusal?.cards ?? []), ...refused.cards])],
          message: refused.message,
        });
      } else setError(describeBoardError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        title={`Group ${cardCountText(n)} into a stack?`}
        description="The cards fold into one stack face on the Board. Each card still runs on its own."
        footer={
          <div className="flex w-full justify-between gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              type="submit"
              form="board-group-stack"
              disabled={!valid}
            >
              {busy ? 'Grouping…' : `Group ${cardCountText(n)}`}
            </Button>
          </div>
        }
      >
        <form
          id="board-group-stack"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {refusal ? (
            <Banner tone="danger" title="Nothing was grouped">
              {`${refusal.message}. `}
              {plan.ready
                ? `Group the other ${n}, or cancel.`
                : 'Too few cards are left to group.'}
            </Banner>
          ) : null}
          <Field label="Title" htmlFor="board-group-title" required>
            <Input
              id="board-group-title"
              value={title}
              maxLength={STACK_TITLE_MAX}
              disabled={busy}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field
            label="Description"
            htmlFor="board-group-body"
            hint="Optional."
          >
            <Textarea
              id="board-group-body"
              rows={3}
              value={body}
              maxLength={STACK_BODY_MAX}
              disabled={busy}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span id="board-group-design" className="text-sm font-medium">
                Shared design
              </span>
              <span className="text-xs text-ink-3">
                Draws one mockup for the whole stack first. Run is held until
                you approve it.
              </span>
            </div>
            <span
              aria-disabled={busy || undefined}
              className={busy ? 'pointer-events-none opacity-60' : undefined}
            >
              <Toggle
                labelledBy="board-group-design"
                checked={design}
                onChange={(value) => {
                  if (!busy) setDesign(value);
                }}
              />
            </span>
          </div>
          <section aria-label="Joining" className="flex flex-col gap-1.5">
            <p className="text-label text-ink-3">Joining {cardCountText(n)}</p>
            <ul className="flex flex-col gap-1 text-sm">
              {cards
                .filter((c) => !leftOut.some((l) => l.card === c))
                .map((c) => {
                  const refused = refusal?.cards.includes(c.number) ?? false;
                  return (
                    <li
                      key={c.number}
                      className={`flex items-center gap-2 ${refused ? 'opacity-60' : ''}`}
                    >
                      <span className="min-w-11 font-mono text-xs">
                        {c.label}
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate ${refused ? 'line-through' : ''}`}
                      >
                        {c.title}
                      </span>
                      <StatusPill
                        size="sm"
                        status={refused ? 'error' : 'idle'}
                        label={refused ? 'Left out' : COLUMN_TITLE[c.column]}
                      />
                    </li>
                  );
                })}
            </ul>
          </section>
          {leftOut.length > 0 ? (
            <Banner tone="info">
              {leftOut
                .map((l) => `${l.card.label} is left out: ${l.why}.`)
                .join(' ')}
            </Banner>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
