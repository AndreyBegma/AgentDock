'use client';

import {
  type ConfirmSplitRequest,
  PLAN_TASK_KINDS,
  type PlanIntakeSplitView,
  type PlanTaskKind,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import { X } from 'lucide-react';
import { useState } from 'react';
import {
  confirmSplitCards,
  confirmSplitText,
  type SplitRow,
  splitRowProblem,
  splitRows,
} from '../../lib/board/intake';
import { pluralize } from '../../lib/format';

const KIND_LABEL: Record<PlanTaskKind, string> = {
  feature: 'Feature',
  bug: 'Bug',
};

/**
 * #409: the intake proposes several cards. First the proposal — why, and
 * the cards (title, kind, summary) — with **Keep one card** and **Split into
 * N cards**. Splitting opens the list to edit: a title and kind per card,
 * and Remove; **Create N cards** makes them all at once. The caller keys it
 * by the proposal's turn, so a new proposal starts over.
 */
export function SplitReview({
  split,
  disabled,
  onKeepOne,
  onConfirm,
}: {
  split: PlanIntakeSplitView;
  disabled: boolean;
  onKeepOne: () => void;
  onConfirm: (request: ConfirmSplitRequest) => Promise<unknown>;
}) {
  const [rows, setRows] = useState<SplitRow[] | null>(null);

  if (rows === null) {
    return (
      <section aria-label="Split proposal" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-ink">
            The planner proposes {pluralize(split.cards.length, 'card')}
          </h3>
          <p className="text-sm whitespace-pre-line break-words text-ink-2">
            {split.reason}
          </p>
        </div>
        <ol className="flex flex-col gap-2">
          {split.cards.map((card) => (
            <li
              key={card.index}
              className="flex flex-col gap-1 rounded-control bg-hover px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 text-sm font-medium break-words text-ink">
                  {card.title}
                </span>
                <KindChip kind={card.kind} />
              </div>
              <p className="text-sm break-words text-ink-3">{card.summary}</p>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="glass" disabled={disabled} onClick={onKeepOne}>
            Keep one card
          </Button>
          <Button disabled={disabled} onClick={() => setRows(splitRows(split))}>
            Split into {pluralize(split.cards.length, 'card')}
          </Button>
        </div>
      </section>
    );
  }

  const problems = rows.map(splitRowProblem);
  const valid = rows.length > 0 && problems.every((p) => p === null);
  const change = (index: number, patch: Partial<SplitRow>) =>
    setRows((current) =>
      (current ?? []).map((r) => (r.index === index ? { ...r, ...patch } : r)),
    );

  return (
    <form
      aria-label="Cards to create"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void onConfirm({
          turnId: split.turnId,
          cards: confirmSplitCards(rows),
        }).catch(() => {});
      }}
    >
      <p className="text-sm text-ink-3">
        Edit the titles and kinds, remove what you do not want, then create the
        cards. Each one lands in Todo on its own, with no plan and no links.
      </p>
      <ol className="flex flex-col gap-3">
        {rows.map((row, position) => (
          <li
            key={row.index}
            className="flex flex-col gap-2 rounded-control bg-hover px-3 py-2"
          >
            <div className="flex min-w-0 items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field
                  label={`Card ${position + 1}`}
                  htmlFor={`split-title-${row.index}`}
                  error={problems[position] ?? undefined}
                >
                  <Input
                    id={`split-title-${row.index}`}
                    value={row.title}
                    disabled={disabled}
                    onChange={(e) =>
                      change(row.index, { title: e.target.value })
                    }
                  />
                </Field>
              </div>
              <Field label="Kind" htmlFor={`split-kind-${row.index}`}>
                <Select
                  id={`split-kind-${row.index}`}
                  value={row.kind}
                  disabled={disabled}
                  onChange={(e) =>
                    change(row.index, { kind: e.target.value as PlanTaskKind })
                  }
                >
                  {PLAN_TASK_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABEL[kind]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || rows.length === 1}
                aria-label={`Remove card ${position + 1}`}
                onClick={() =>
                  setRows((current) =>
                    (current ?? []).filter((r) => r.index !== row.index),
                  )
                }
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </div>
            <p className="text-sm break-words text-ink-3">{row.summary}</p>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="glass"
          disabled={disabled}
          onClick={() => setRows(null)}
        >
          Back
        </Button>
        <Button type="submit" disabled={disabled || !valid}>
          {confirmSplitText(rows.length)}
        </Button>
      </div>
    </form>
  );
}

function KindChip({ kind }: { kind: PlanTaskKind }) {
  return (
    <Chip size="sm" tone={kind === 'bug' ? 'danger' : undefined}>
      {KIND_LABEL[kind]}
    </Chip>
  );
}
