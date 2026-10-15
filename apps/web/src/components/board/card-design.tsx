'use client';

import type { BoardCardView, UiProfileView } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { Ellipsis } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { api, type Described } from '../../lib/api';
import { updateCard } from '../../lib/board/actions';
import { describeBoardError } from '../../lib/board/format';
import {
  CARD_DESIGN_CHIP_LABEL,
  type CardDesignChipState,
  canChangeContinue,
  canToggleCardDesign,
  cardDesignChipState,
  cardDesignChipText,
  describeDesignError,
  opensCardDesign,
} from '../../lib/design/format';
import {
  cardDesignApi,
  cardDesignHref,
  uiProfileApi,
} from '../../lib/design/href';
import { useErrorToast } from '../../lib/section/use-error-toast';
import { useSection } from '../../lib/section/use-section';

/** A badge is a fact, not a status (style system): only approval is toned. */
const CHIP_TONE: Record<CardDesignChipState, 'neutral' | 'ok'> = {
  off: 'neutral',
  on: 'neutral',
  generating: 'neutral',
  reviewing: 'neutral',
  approved: 'ok',
};

/** The chip's clock ticks once a second, and only while the design is drawn (#275 D8). */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * The Design chip on a card's face (#243): shown once the design is on, with
 * a second one while the worker will start by itself on approval.
 */
export function CardFaceDesign({ card }: { card: BoardCardView }) {
  const state = cardDesignChipState(card.design);
  const now = useClock(state === 'generating');
  if (state === 'off') return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge
        size="md"
        tone={CHIP_TONE[state]}
        label={cardDesignChipText(card.design, now)}
      />
      {card.continueAfterDesign && state !== 'approved' ? (
        <Badge size="md" label="Runs after design" />
      ) : null}
    </div>
  );
}

/**
 * The card sheet's design section (#243, D5, D9): the Design chip with its
 * toggle and **Open design**, and the "Continue after design" switch. Both
 * save at once, like the Planner's chip; a project whose UI profile says it
 * has no UI keeps the design toggle behind "Design anyway…".
 */
export function CardDesignSection({
  projectId,
  card,
  canOperate,
  onChanged,
}: {
  projectId: string;
  card: BoardCardView;
  canOperate: boolean;
  onChanged: () => void;
}) {
  const chipId = useId();
  const continueId = useId();
  const [busy, setBusy] = useState(false);
  const [warnOpen, setWarnOpen] = useState(false);
  const showError = useErrorToast();
  // A profile that does not load is treated as none: the toggle shows.
  const profile = useSection(
    () => api<UiProfileView>(uiProfileApi(projectId)),
    [projectId],
  );
  const hasUi = profile.data?.current?.hasUi ?? null;

  const state = cardDesignChipState(card.design);
  const needed = card.design?.needed === true;
  const editable = canOperate && canToggleCardDesign(card);
  const behindMenu = hasUi === false && !needed;
  const switchable = canOperate && canChangeContinue(card);

  const run = async (
    job: () => Promise<unknown>,
    describe: (error: unknown) => Described,
  ) => {
    setBusy(true);
    try {
      await job();
      onChanged();
    } catch (error) {
      showError(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const setNeeded = (next: boolean) =>
    run(
      () =>
        api(cardDesignApi(projectId, card.number), {
          method: 'PATCH',
          body: { needed: next },
        }),
      (error) => describeDesignError(error, projectId),
    );

  const setContinue = (next: boolean) =>
    run(
      () => updateCard(projectId, card.number, { continueAfterDesign: next }),
      (error) => describeBoardError(error),
    );

  return (
    <section aria-label="Design" className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Design</h3>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          id={chipId}
          size="md"
          tone={CHIP_TONE[state]}
          label={CARD_DESIGN_CHIP_LABEL[state]}
        />

        {editable && !behindMenu ? (
          <span className={busy ? 'pointer-events-none opacity-60' : undefined}>
            <Toggle
              checked={needed}
              labelledBy={chipId}
              onChange={(next) => void setNeeded(next)}
            />
          </span>
        ) : null}

        {editable && behindMenu ? (
          <>
            <MenuRoot>
              <MenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  icon
                  aria-label="Design options"
                  disabled={busy}
                >
                  <Ellipsis aria-hidden="true" className="size-4" />
                </Button>
              </MenuTrigger>
              <MenuContent align="start">
                <MenuItem onSelect={() => setWarnOpen(true)}>
                  Design anyway…
                </MenuItem>
              </MenuContent>
            </MenuRoot>
            <ConfirmDialog
              open={warnOpen}
              onOpenChange={setWarnOpen}
              title="Design a card in a project without UI?"
              consequence="The project's UI profile says it has no user interface. A design costs a planner turn per variant, and Run waits until you approve it."
              verb="Design anyway"
              tone="default"
              busy={busy}
              onConfirm={() => {
                setWarnOpen(false);
                void setNeeded(true);
              }}
            />
          </>
        ) : null}

        {opensCardDesign(card.design) ? (
          <Link
            href={cardDesignHref(projectId, card.number)}
            className={buttonClassName({ variant: 'glass', size: 'sm' })}
          >
            Open design
          </Link>
        ) : null}
      </div>

      {needed ? (
        <div className="flex items-center gap-2">
          {switchable ? (
            <span
              className={busy ? 'pointer-events-none opacity-60' : undefined}
            >
              <Toggle
                checked={card.continueAfterDesign}
                labelledBy={continueId}
                onChange={(next) => void setContinue(next)}
              />
            </span>
          ) : null}
          <span id={continueId} className="text-sm">
            Continue after design
            {switchable ? '' : card.continueAfterDesign ? ': on' : ': off'}
          </span>
        </div>
      ) : null}
      {needed && switchable ? (
        <p className="text-xs text-ink-3">
          {card.continueAfterDesign
            ? 'Approving the design starts the worker.'
            : 'Approving the design leaves the card in To Do; you press Run.'}
        </p>
      ) : null}
    </section>
  );
}
