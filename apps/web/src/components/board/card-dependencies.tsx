'use client';

import type { BoardCardDetail, CardDependenciesView } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { X } from 'lucide-react';
import { useState } from 'react';
import {
  addDependency,
  fetchDependencies,
  removeDependency,
} from '../../lib/board/actions';
import {
  isOpenDependency,
  parseCardNumber,
} from '../../lib/board/dependencies';
import { COLUMN_TITLE, describeBoardError } from '../../lib/board/format';
import { useSection } from '../../lib/section/use-section';

/**
 * The cards this one runs after (#337 D8), each ready (Finished: its pull
 * request is ready), accepted (Completed) or open with its column (#443,
 * #638) — the header counts the open ones. An operator adds one by its
 * number and removes one; a cycle or a card of another project is refused
 * by the API and said here. An open dependency holds Run (ADR-0064); it
 * never blocks a move or Accept.
 */
export function CardDependenciesSection({
  projectId,
  card,
  canOperate,
  onChanged,
}: {
  projectId: string;
  card: Pick<BoardCardDetail, 'number' | 'label' | 'dependsOn'>;
  canOperate: boolean;
  /** The board's faces show the chip: refetch them after a change. */
  onChanged: () => void;
}) {
  // #443: a dependency accepted elsewhere reaches the card by a live push;
  // its columns are the refetch key, so the list follows.
  const columns = (card.dependsOn ?? [])
    .map((d) => `${d.number}:${d.column}`)
    .join(',');
  const section = useSection(
    () => fetchDependencies(projectId, card.number),
    [projectId, card.number, columns],
  );
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fieldId = `card-${card.number}-depends-on`;

  const change = async (job: () => Promise<CardDependenciesView>) => {
    setBusy(true);
    setError(undefined);
    try {
      section.setData(await job());
      onChanged();
      return true;
    } catch (err) {
      setError(describeBoardError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const number = parseCardNumber(draft);
    if (number === null) {
      setError('Type a card number, like 12 or C-12.');
      return;
    }
    if (
      await change(() =>
        addDependency(projectId, card.number, { dependsOn: number }),
      )
    ) {
      setDraft('');
    }
  };

  const list = section.data?.dependsOn ?? [];
  const open = list.filter((d) => isOpenDependency(d.column)).length;

  return (
    <section aria-label="Depends on" className="flex flex-col gap-2">
      <SectionHeader
        title="Depends on"
        headingLevel={3}
        actions={
          list.length === 0 ? undefined : open > 0 ? (
            <Badge size="md" tone="warn" label={`${open} open`} />
          ) : (
            <Badge size="md" tone="ok" label="All ready" />
          )
        }
      />
      {section.data === undefined && !section.error ? (
        <Skeleton className="h-10 w-full" />
      ) : section.error && section.data === undefined ? (
        <p className="text-sm text-danger">
          The dependencies could not be loaded.{' '}
          <button
            type="button"
            className="text-accent-ink underline underline-offset-2"
            onClick={section.retry}
          >
            Try again
          </button>
        </p>
      ) : list.length === 0 ? (
        <p className="text-sm text-ink-3">
          {card.label} does not wait for another card.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {list.map((d) => (
            <li
              key={d.number}
              className="flex min-w-0 items-center gap-2 py-2 text-sm"
            >
              <span className="font-mono text-xs text-ink-2">{d.label}</span>
              <span
                className="min-w-0 flex-1 truncate text-ink"
                title={d.title}
              >
                {d.title}
              </span>
              {isOpenDependency(d.column) ? (
                <StatusPill
                  size="sm"
                  status="waiting"
                  label={COLUMN_TITLE[d.column]}
                />
              ) : (
                <StatusPill
                  size="sm"
                  status="done"
                  label={d.column === 'finished' ? 'PR ready' : 'Accepted'}
                />
              )}
              {canOperate ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Remove the dependency on ${d.label}`}
                  onClick={() =>
                    void change(() =>
                      removeDependency(projectId, card.number, d.number),
                    )
                  }
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 ? (
        <p className="text-xs text-ink-3">
          PR ready means the card is in {COLUMN_TITLE.finished}, Accepted that
          it is in {COLUMN_TITLE.completed}. Run waits until every one is
          either.
        </p>
      ) : null}
      {canOperate ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="min-w-0 flex-1">
            <Field label="Runs after card" htmlFor={fieldId}>
              <Input
                id={fieldId}
                placeholder="C-12"
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="glass"
            disabled={busy || draft.trim() === ''}
          >
            Add
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
