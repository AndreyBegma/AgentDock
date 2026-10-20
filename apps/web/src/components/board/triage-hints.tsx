'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { toast } from '@andrewbehma/glass-ui/toast';
import type { CardTriageView, TriageHint } from '@nautelle/shared';
import { Sparkles } from 'lucide-react';
import NextLink from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { describeError } from '../../lib/api';
import { boardCardHref } from '../../lib/board/href';
import { applyHint, dismissHint, fetchTriage } from '../../lib/board-ai/client';
import { priorityHintLabel, triageHintCount } from '../../lib/board-ai/triage';

/**
 * #660 triage hints of a card the intake or the assistant made: possible
 * duplicates, a kind and a priority. They never block and never change the
 * card on their own — Apply is the person's, and every hint can be
 * dismissed. Nothing shows while the triage runs, failed, or its provider is
 * at its cap.
 */
export function TriageHints({
  projectId,
  number,
  refresh,
  canOperate,
  onChanged,
}: {
  projectId: string;
  number: number;
  /** Changes when the card was fetched again: the hints are read again too. */
  refresh: unknown;
  canOperate: boolean;
  onChanged: () => void;
}) {
  const [view, setView] = useState<CardTriageView>();
  const [busy, setBusy] = useState<TriageHint>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is a refetch trigger
  useEffect(() => {
    let live = true;
    fetchTriage(projectId, number).then(
      (next) => live && setView(next),
      // Hints are advice: a failed read shows none.
      () => live && setView(undefined),
    );
    return () => {
      live = false;
    };
  }, [projectId, number, refresh]);

  if (!view || view.state !== 'ready' || triageHintCount(view) === 0) {
    return null;
  }

  const act = async (hint: TriageHint, apply: boolean) => {
    setBusy(hint);
    try {
      setView(await (apply ? applyHint : dismissHint)(projectId, number, hint));
      if (apply) onChanged();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(undefined);
    }
  };

  const buttons = (hint: TriageHint, applicable: boolean) =>
    canOperate ? (
      <div className="flex shrink-0 gap-1.5">
        {applicable ? (
          <Button
            size="sm"
            variant="glass"
            disabled={busy !== undefined}
            onClick={() => void act(hint, true)}
          >
            Apply
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== undefined}
          onClick={() => void act(hint, false)}
        >
          Dismiss
        </Button>
      </div>
    ) : null;

  return (
    <section
      aria-label="Triage hints"
      className="flex flex-col gap-2 rounded-control border border-line p-3"
    >
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
        <Sparkles className="size-3.5" aria-hidden="true" />
        Triage hints
        <span className="font-normal text-ink-3">
          · nothing changes until you apply
        </span>
      </h3>
      {view.duplicates ? (
        <Hint
          title={
            <>
              Possibly a duplicate of{' '}
              {view.duplicates.map((d, i) => (
                <span key={d.number}>
                  {i > 0 ? ', ' : null}
                  <NextLink
                    href={boardCardHref(projectId, d.number)}
                    className="font-medium text-accent-ink underline-offset-2 hover:underline"
                    title={d.title}
                  >
                    {d.label}
                  </NextLink>
                </span>
              ))}
            </>
          }
          reason={view.duplicates.map((d) => d.reason).join(' ')}
          actions={buttons('duplicates', false)}
        />
      ) : null}
      {view.kind ? (
        <Hint
          title={`Suggested kind: ${view.kind.value === 'bug' ? 'Bug' : 'Feature'}`}
          reason={view.kind.reason}
          actions={buttons('kind', true)}
        />
      ) : null}
      {view.priority ? (
        <Hint
          title={priorityHintLabel(view.priority.value)}
          reason={view.priority.reason}
          actions={buttons('priority', true)}
        />
      ) : null}
    </section>
  );
}

function Hint({
  title,
  reason,
  actions,
}: {
  title: ReactNode;
  reason: string;
  actions: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">{title}</p>
        {reason ? <p className="text-xs text-ink-3">{reason}</p> : null}
      </div>
      {actions}
    </div>
  );
}
