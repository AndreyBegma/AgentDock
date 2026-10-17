'use client';

import type { AcceptCandidatesResponse } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Select } from '@andrewbehma/glass-ui/select';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { acceptCandidates } from '../../lib/board/candidate-actions';
import {
  acceptCardsRequest,
  acceptStackRequest,
  attachmentNotes,
  candidateDecidedOf,
  type IntakeCandidate,
  isCandidateStale,
  moveRow,
  type StackRow,
  setRowStage,
  stackGetsDesign,
  stackPreview,
  stackRowsOf,
} from '../../lib/board/candidates';
import { draftTitle } from '../../lib/board/intake';
import { pluralize } from '../../lib/format';
import { describePlannerError } from '../../lib/planner/format';
import { KindChip } from './split-review';

export type AcceptMode = 'cards' | 'stack';

/**
 * #592 (ADR-0056): the selected candidates — of one intake or several —
 * accepted together. As independent cards: each its own card in Todo, no
 * dependencies. As a stack: each in the stage the person orders them in, a
 * stage waiting on the one before it, and a shared design when a
 * candidate's intake asked for one (ADR-0044). The intakes' attachments go
 * to the first card accepted from each (ADR-0037 §4).
 */
export function AcceptCandidatesDialog({
  projectId,
  mode,
  selected,
  onOpenChange,
  onAccepted,
}: {
  projectId: string;
  /** Undefined: closed. */
  mode: AcceptMode | undefined;
  selected: readonly IntakeCandidate[];
  onOpenChange: (open: boolean) => void;
  onAccepted: (response: AcceptCandidatesResponse) => void;
}) {
  const [rows, setRows] = useState<StackRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Each opening starts from the selection as it is now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on open only
  useEffect(() => {
    if (mode === undefined) return;
    setRows(stackRowsOf(selected));
    setError(undefined);
  }, [mode]);

  const n = selected.length;
  const stack = mode === 'stack';
  const design = stack && stackGetsDesign(selected);
  const notes = attachmentNotes(selected, stack ? 'stage 1' : 'its first card');

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const made = await acceptCandidates(
        projectId,
        stack ? acceptStackRequest(rows) : acceptCardsRequest(selected),
      );
      onAccepted(made);
    } catch (err) {
      const decided = candidateDecidedOf(err);
      setError(
        decided
          ? `A candidate was ${decided.status} already${decided.card ? ` as ${decided.card.label}` : ''}. Nothing was accepted; close this and select again.`
          : isCandidateStale(err)
            ? 'A candidate was changed in another tab. Nothing was accepted; close this and select again.'
            : describePlannerError(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot
      open={mode !== undefined}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        title={
          stack
            ? `Accept ${pluralize(n, 'card')} as a stack?`
            : `Accept ${pluralize(n, 'card')} on their own?`
        }
        description={
          stack
            ? 'Each stage starts once the one before it is merged. Change the order if the proposal has it wrong.'
            : 'Each becomes its own card in Todo, with no dependencies between them. The orchestrator may run them in parallel.'
        }
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              disabled={busy || n === 0 || (stack && n < 2)}
              onClick={() => void submit()}
            >
              {busy
                ? 'Accepting…'
                : stack
                  ? 'Accept as stack'
                  : `Accept ${pluralize(n, 'card')}`}
            </Button>
          </div>
        }
      >
        <div className="flex min-w-0 flex-col gap-4">
          {stack ? (
            <StageOrder rows={rows} onChange={setRows} disabled={busy} />
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {selected.map(({ candidate }) => (
                <li
                  key={candidate.id}
                  className="flex min-w-0 items-center gap-2"
                >
                  <KindChip kind={candidate.kind} />
                  <span className="min-w-0 truncate">{candidate.title}</span>
                </li>
              ))}
            </ul>
          )}
          {stack ? (
            <section
              aria-label="What gets created"
              className="flex flex-col gap-1 rounded-control bg-hover px-3 py-2 text-xs text-ink-2"
            >
              <span className="text-label text-ink-3">Creates in Todo</span>
              {stackPreview(rows).map((line) => (
                <span key={line.stage}>
                  Stage {line.stage}{' '}
                  <code className="font-mono">{line.titles.join(', ')}</code>
                  {line.dependsOn
                    ? ` · depends on stage ${line.dependsOn}`
                    : ''}
                </span>
              ))}
            </section>
          ) : null}
          {design || notes.length > 0 ? (
            <Banner tone="info">
              {[
                design
                  ? 'The stack ends in UI, so a design is drafted for it, as for a confirmed stack.'
                  : null,
                ...notes,
              ]
                .filter(Boolean)
                .join(' ')}
            </Banner>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

/** The stack's rows: a stage for each, chosen with the select or moved up and down. */
function StageOrder({
  rows,
  onChange,
  disabled,
}: {
  rows: readonly StackRow[];
  onChange: (rows: StackRow[]) => void;
  disabled: boolean;
}) {
  return (
    <ol aria-label="Stage order" className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <li
          key={row.candidate.id}
          className="flex min-w-0 items-center gap-2 rounded-control border border-line px-2 py-1.5"
        >
          <Select
            aria-label={`Stage for ${row.candidate.title}`}
            className="w-28 shrink-0"
            value={row.stage}
            disabled={disabled}
            onChange={(e) =>
              onChange(setRowStage(rows, i, Number(e.target.value)))
            }
          >
            {rows.map((other, stage) => (
              <option key={other.candidate.id} value={stage}>
                Stage {stage + 1}
              </option>
            ))}
          </Select>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5 text-sm">
              <KindChip kind={row.candidate.kind} />
              <span className="min-w-0 truncate">{row.candidate.title}</span>
            </span>
            <span className="truncate text-xs text-ink-3">
              {draftTitle(row.plan)}
            </span>
          </div>
          <span className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="ghost"
              icon
              aria-label="Move up"
              disabled={disabled || i === 0}
              onClick={() => onChange(moveRow(rows, i, -1))}
            >
              <ChevronUp className="size-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon
              aria-label="Move down"
              disabled={disabled || i === rows.length - 1}
              onClick={() => onChange(moveRow(rows, i, 1))}
            >
              <ChevronDown className="size-4" aria-hidden />
            </Button>
          </span>
        </li>
      ))}
    </ol>
  );
}
