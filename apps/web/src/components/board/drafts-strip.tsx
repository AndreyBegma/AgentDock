'use client';

import type { PlanDetail, PlanListView, PlanSummary } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { toast } from '@andrewbehma/glass-ui/toast';
import { MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import {
  discussionSkills,
  discussStateText,
  isDiscussion,
} from '../../lib/board/discuss';
import {
  DRAFTS_SHOWN_MAX,
  draftStateText,
  draftTitle,
  openDrafts,
} from '../../lib/board/intake';
import { describePlannerError } from '../../lib/planner/format';
import { planApi } from '../../lib/planner/href';
import { useSection } from '../../lib/section/use-section';

/**
 * Drafts (#337 D2), above the columns: the person's open New work intakes
 * and earlier plans, each with where it stands — "2 questions waiting",
 * "thinking…", "split into 3 cards?" (#409) — and **Resume** / **Discard**.
 * Discard closes the plan (archive); no card is made. #590: discussions sit
 * among them, with their skills and "6 messages · 2 cards proposed". Below
 * `sm` the strip is a scroll-snap rail whose next draft peeks in. Hidden
 * when there is none.
 */
export function DraftsStrip({
  projectId,
  userId,
  version,
  onResume,
  onDiscarded,
}: {
  projectId: string;
  userId: string;
  /** Bumped by the Board's live pushes and mutations. */
  version: number;
  onResume: (plan: PlanSummary) => void;
  onDiscarded: (plan: PlanSummary) => void;
}) {
  const drafts = useSection(async () => {
    const list = await api<PlanListView>(`/projects/${projectId}/plans`);
    const mine = openDrafts(list.items, userId).slice(0, DRAFTS_SHOWN_MAX);
    // The summary has no round or running turn: each draft's detail does.
    const details = await Promise.all(
      mine.map((p) =>
        api<PlanDetail>(planApi(projectId, p.id)).catch(() => undefined),
      ),
    );
    return mine.map((summary, i) => ({ summary, detail: details[i] }));
  }, [projectId, userId, version]);
  const [discarding, setDiscarding] = useState<PlanSummary>();
  const [busy, setBusy] = useState(false);

  const discard = async () => {
    if (!discarding) return;
    setBusy(true);
    try {
      await api(`${planApi(projectId, discarding.id)}/archive`, {
        method: 'POST',
      });
      toast.success(
        isDiscussion(discarding) ? 'Discussion discarded.' : 'Draft discarded.',
      );
      onDiscarded(discarding);
      setDiscarding(undefined);
      drafts.retry();
    } catch (err) {
      toast.error(describePlannerError(err));
    } finally {
      setBusy(false);
    }
  };

  const items = drafts.data ?? [];
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="board-drafts" className="flex flex-col gap-2">
      <h2 id="board-drafts" className="text-sm font-semibold text-ink">
        Drafts
      </h2>
      <ul className="flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto pb-1">
        {items.map(({ summary, detail }) => (
          <li
            key={summary.id}
            className="w-72 shrink-0 snap-start max-sm:w-[84%]"
          >
            <Card
              variant="content"
              pad="sm"
              className="flex h-full min-w-0 flex-col gap-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Chip size="sm" className="shrink-0 gap-1">
                  {isDiscussion(summary) ? (
                    <MessagesSquare className="size-3" aria-hidden="true" />
                  ) : null}
                  {draftKind(summary)}
                </Chip>
                <span className="truncate text-sm font-medium text-ink">
                  {draftTitle(summary)}
                </span>
              </div>
              {discussionSkills(detail).length > 0 ? (
                <ul aria-label="Skills" className="flex flex-wrap gap-1">
                  {discussionSkills(detail).map((s) => (
                    <li key={s}>
                      <Chip size="sm">{s}</Chip>
                    </li>
                  ))}
                </ul>
              ) : null}
              <span className="text-xs text-ink-2" aria-live="polite">
                {(isDiscussion(summary)
                  ? discussStateText(detail)
                  : draftStateText(detail)) ?? '…'}
              </span>
              <div className="mt-auto flex gap-2 max-lg:[--size-control:44px]">
                <Button size="sm" onClick={() => onResume(summary)}>
                  Resume
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDiscarding(summary)}
                >
                  Discard
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={discarding !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) setDiscarding(undefined);
        }}
        title={`Discard “${discarding ? draftTitle(discarding) : ''}”?`}
        consequence={
          discarding?.mode === 'card'
            ? 'The interview is closed and no card is made from it.'
            : discarding?.mode === 'discuss'
              ? 'The discussion is archived and leaves Drafts. Cards already made from its proposals stay on the Board.'
              : 'The plan is closed and no cards are made from it.'
        }
        verb="Discard"
        tone="danger"
        busy={busy}
        onConfirm={() => void discard()}
      />
    </section>
  );
}

/** The chip of a draft: what kind of draft it is. */
const draftKind = (plan: PlanSummary): string =>
  plan.mode === 'card'
    ? 'New work'
    : plan.mode === 'discuss'
      ? 'Discussion'
      : 'Plan';
