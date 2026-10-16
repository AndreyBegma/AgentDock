'use client';

import {
  type ConfirmSplitRequest,
  PLAN_TASK_KINDS,
  type PlanIntakeSplitView,
  type PlanTaskKind,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { Field, Input, Select, Textarea } from '@andrewbehma/glass-ui/field';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import { useState } from 'react';
import {
  addStage,
  confirmHint,
  confirmRequest,
  confirmText,
  dropFromStages,
  moveToStage,
  type ProposalShape,
  proposalTitle,
  proposedShape,
  type SplitRow,
  type StackDraft,
  splitRowProblem,
  splitRows,
  stackDraft,
  stackProblem,
} from '../../lib/board/intake';
import { pluralize } from '../../lib/format';

const KIND_LABEL: Record<PlanTaskKind, string> = {
  feature: 'Feature',
  bug: 'Bug',
};

const SHAPES: { id: ProposalShape; label: string }[] = [
  { id: 'split', label: 'Split' },
  { id: 'stack', label: 'Stack' },
];

/**
 * #409, #480: the intake proposes several cards — independent (a split) or
 * one stack in ordered stages. The person switches the proposal between
 * **Split** and **Stack**, edits the titles and kinds, removes cards, and —
 * as a stack — names it, says whether a stack design comes first, and moves
 * cards between stages. One Confirm makes them all. The caller keys it by
 * the proposal's turn, so a new proposal starts over.
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
  const [shape, setShape] = useState<ProposalShape>(proposedShape(split));
  const [rows, setRows] = useState<SplitRow[]>(() => splitRows(split));
  const [stack, setStack] = useState<StackDraft>(() => stackDraft(split));

  const problems = rows.map(splitRowProblem);
  const stackIssue = shape === 'stack' ? stackProblem(stack) : null;
  const valid =
    rows.length > 0 && problems.every((p) => p === null) && stackIssue === null;
  const byIndex = new Map(rows.map((r) => [r.index, r]));
  const change = (index: number, patch: Partial<SplitRow>) =>
    setRows((current) =>
      current.map((r) => (r.index === index ? { ...r, ...patch } : r)),
    );
  const remove = (index: number) => {
    setRows((current) => current.filter((r) => r.index !== index));
    setStack((current) => dropFromStages(current, index));
  };

  return (
    <form
      aria-label="Proposal"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void onConfirm(confirmRequest(split.turnId, shape, rows, stack)).catch(
          () => {},
        );
      }}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-sm font-semibold text-ink">
            {proposalTitle(split)}
          </h3>
          <p className="text-sm whitespace-pre-line break-words text-ink-2">
            {split.reason}
          </p>
        </div>
        <SegmentedControl role="group" aria-label="Proposal shape" size="sm">
          {SHAPES.map(({ id, label }) => (
            <SegmentedControlItem
              key={id}
              active={shape === id}
              layoutId="proposal-shape"
            >
              <button
                type="button"
                aria-pressed={shape === id}
                disabled={disabled}
                className="px-2.5 py-1 text-xs whitespace-nowrap"
                onClick={() => setShape(id)}
              >
                {label}
              </button>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>

      {shape === 'stack' ? (
        <StackFields
          stack={stack}
          rows={byIndex}
          problems={new Map(rows.map((r, i) => [r.index, problems[i]]))}
          issue={stackIssue}
          disabled={disabled}
          onChange={setStack}
          onRowChange={change}
          onRemove={remove}
          canRemove={rows.length > 1}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-ink-3">
            Independent cards: no stages, no shared design, no dependencies
            between them.
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
                  <KindField
                    row={row}
                    disabled={disabled}
                    onChange={(kind) => change(row.index, { kind })}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || rows.length === 1}
                    aria-label={`Remove card ${position + 1}`}
                    onClick={() => remove(row.index)}
                  >
                    <X aria-hidden="true" className="size-4" />
                  </Button>
                </div>
                <p className="text-sm break-words text-ink-3">{row.summary}</p>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-line border-t pt-3">
        <Button variant="ghost" disabled={disabled} onClick={onKeepOne}>
          Keep one card
        </Button>
        <span className="ms-auto text-xs text-ink-3">
          {confirmHint(shape, stack.design)}
        </span>
        <Button type="submit" disabled={disabled || !valid}>
          {confirmText(shape, rows.length)}
        </Button>
      </div>
    </form>
  );
}

/** #480: the stack's title, description, design switch and stages. */
function StackFields({
  stack,
  rows,
  problems,
  issue,
  disabled,
  canRemove,
  onChange,
  onRowChange,
  onRemove,
}: {
  stack: StackDraft;
  rows: ReadonlyMap<number, SplitRow>;
  problems: ReadonlyMap<number, string | null>;
  issue: string | null;
  disabled: boolean;
  canRemove: boolean;
  onChange: (next: StackDraft) => void;
  onRowChange: (index: number, patch: Partial<SplitRow>) => void;
  onRemove: (index: number) => void;
}) {
  const last = stack.stages.length - 1;
  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Stack title"
        htmlFor="stack-title"
        error={issue && stack.title.trim() === '' ? issue : undefined}
      >
        <Input
          id="stack-title"
          value={stack.title}
          disabled={disabled}
          onChange={(e) => onChange({ ...stack, title: e.target.value })}
        />
      </Field>
      <Field label="Stack description" htmlFor="stack-body">
        <Textarea
          id="stack-body"
          rows={3}
          value={stack.body}
          disabled={disabled}
          onChange={(e) => onChange({ ...stack, body: e.target.value })}
        />
      </Field>
      <div className="flex items-center gap-3 rounded-control bg-hover px-3 py-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <span id="stack-design" className="text-sm font-medium text-ink">
            Draw a stack design first
          </span>
          <span className="text-xs text-ink-3">
            One mockup of the whole result. No card runs until it is approved.
          </span>
        </span>
        <span
          inert={disabled || undefined}
          className={disabled ? 'opacity-60' : undefined}
        >
          <Toggle
            labelledBy="stack-design"
            checked={stack.design}
            onChange={(design) => onChange({ ...stack, design })}
          />
        </span>
      </div>

      <ol aria-label="Stages" className="flex flex-col gap-2">
        {stack.stages.map((stage, i) => (
          <li
            // Stages have no id of their own while they are drafted.
            // biome-ignore lint/suspicious/noArrayIndexKey: the position is the stage
            key={i}
            className="flex flex-col gap-2 rounded-control border border-line p-2"
          >
            <div className="flex items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-ink tabular-nums">
                {i + 1}
              </span>
              <Input
                aria-label={`Stage ${i + 1} name`}
                value={stage.title}
                disabled={disabled}
                className="h-6 max-w-48 font-semibold"
                onChange={(e) =>
                  onChange({
                    ...stack,
                    stages: stack.stages.map((s, j) =>
                      j === i ? { ...s, title: e.target.value } : s,
                    ),
                  })
                }
              />
              <span className="ms-auto text-xs text-ink-3 tabular-nums">
                {pluralize(stage.cards.length, 'card')}
                {i > 0 ? ` · after Stage ${i}` : ''}
              </span>
            </div>
            {stage.cards.length === 0 ? (
              <p className="py-1 text-xs text-ink-3">
                Empty stage. Move a card here or it is dropped on confirm.
              </p>
            ) : null}
            {stage.cards.map((index) => {
              const row = rows.get(index);
              if (!row) return null;
              const problem = problems.get(index);
              return (
                <div
                  key={index}
                  className="flex min-w-0 items-start gap-2 rounded-control bg-hover px-3 py-2"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Input
                      aria-label={`Title of ${row.title || 'card'}`}
                      value={row.title}
                      disabled={disabled}
                      className="font-medium"
                      onChange={(e) =>
                        onRowChange(index, { title: e.target.value })
                      }
                    />
                    {problem ? (
                      <span role="alert" className="text-xs text-danger">
                        {problem}
                      </span>
                    ) : null}
                    <span className="text-xs break-words text-ink-3">
                      {row.summary}
                    </span>
                  </div>
                  <KindChip kind={row.kind} />
                  <div className="flex shrink-0 items-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Move to previous stage"
                      disabled={disabled || i === 0}
                      onClick={() => onChange(moveToStage(stack, index, -1))}
                    >
                      <ChevronUp aria-hidden="true" className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Move to next stage"
                      disabled={disabled || i === last}
                      onClick={() => onChange(moveToStage(stack, index, 1))}
                    >
                      <ChevronDown aria-hidden="true" className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Remove card"
                      disabled={disabled || !canRemove}
                      onClick={() => onRemove(index)}
                    >
                      <X aria-hidden="true" className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || stack.stages.length >= rows.size}
          onClick={() => onChange(addStage(stack))}
        >
          <Plus aria-hidden="true" className="size-3.5" />
          Add stage
        </Button>
        <span className="ms-auto text-xs text-ink-3">
          Every card of a stage waits on all cards of the stage before it.
        </span>
      </div>
      {issue && stack.title.trim() !== '' ? (
        <p role="alert" className="text-xs text-danger">
          {issue}
        </p>
      ) : null}
    </div>
  );
}

function KindField({
  row,
  disabled,
  onChange,
}: {
  row: SplitRow;
  disabled: boolean;
  onChange: (kind: PlanTaskKind) => void;
}) {
  return (
    <Field label="Kind" htmlFor={`split-kind-${row.index}`}>
      <Select
        id={`split-kind-${row.index}`}
        value={row.kind}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as PlanTaskKind)}
      >
        {PLAN_TASK_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {KIND_LABEL[kind]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function KindChip({ kind }: { kind: PlanTaskKind }) {
  return (
    <Chip size="sm" tone={kind === 'bug' ? 'danger' : undefined}>
      {KIND_LABEL[kind]}
    </Chip>
  );
}
