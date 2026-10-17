'use client';

import type { BoardCardView } from '@agentdock/shared';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { Progress } from '@andrewbehma/glass-ui/progress';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { ChevronDown, Layers, TriangleAlert } from 'lucide-react';
import NextLink from 'next/link';
import { type ReactNode, useId, useState } from 'react';
import { dependencyChip } from '../../lib/board/dependencies';
import {
  COLUMN_TITLE,
  canRetry,
  canRun,
  roundPill,
} from '../../lib/board/format';
import { boardStackPageHref } from '../../lib/board/href';
import {
  type StackItem,
  stackCost,
  stackDesignChip,
  stackKindText,
  stackProgressText,
  stackStage,
  stackStages,
} from '../../lib/board/stacks';
import { formatCost } from '../../lib/format';
import { TAP, TAP_ROW } from './tap';
import type { CardActions } from './use-card-actions';

/** A chip on the header's 16 px line, as on a card face (C-35). */
const HEAD_CHIP = 'h-4 shrink-0';

/**
 * #480 (ADR-0044): a stack on the Board — one collapsed face in the column of
 * its least advanced unfinished card: its label, title, progress (accepted /
 * total), current stage and, while it holds the stack, the design chip.
 * **Expand** opens it in place to its cards by stage, each with its own
 * column; **Collapse** brings the face back. **Open stack** goes to its page.
 */
export function StackFace({
  projectId,
  item,
  canOperate,
  actions,
  menu,
  defaultOpen = false,
  onOpenCard,
}: {
  projectId: string;
  item: StackItem;
  canOperate: boolean;
  actions: CardActions;
  /** The Board's item menu (`slots.menu`), placed at the end of the header. */
  menu?: ReactNode;
  /** Opens expanded; the face starts collapsed. */
  defaultOpen?: boolean;
  onOpenCard: (card: BoardCardView) => void;
}) {
  const { stack } = item;
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const cost = stackCost(stack);
  const designChip = stackDesignChip(stack);
  const href = boardStackPageHref(projectId, stack.number);
  return (
    <div
      data-stack-number={stack.number}
      className="relative flex min-w-0 flex-col gap-1.5 text-sm"
    >
      <div
        // #497: the menu trigger's 44 px touch target stays inside the row.
        className={`flex h-4 min-w-0 items-center gap-1.5 whitespace-nowrap text-xs leading-4 text-ink-2${menu ? ' pointer-coarse:h-(--size-tap)' : ''}`}
      >
        <Chip size="sm" className={`${HEAD_CHIP} gap-1 font-mono`}>
          <Layers aria-hidden="true" className="size-3" />
          {stack.label}
        </Chip>
        <span className="truncate">{stackKindText(stack)}</span>
        <span className="ms-auto flex shrink-0 items-center gap-1">
          {cost ? <span className="tabular-nums">{cost}</span> : null}
          {menu}
        </span>
      </div>
      <NextLink
        href={href}
        className={`${TAP} break-words font-medium underline-offset-2 hover:underline`}
      >
        {stack.title}
      </NextLink>
      <Progress
        label={stackProgressText(stack)}
        value={stack.accepted}
        max={Math.max(stack.total, 1)}
        tone={stack.accepted === stack.total ? 'ok' : 'neutral'}
      />
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Chip size="sm">{stackStage(stack)}</Chip>
        {designChip ? (
          <Chip size="sm" tone="warn" className="gap-1">
            <TriangleAlert aria-hidden="true" className="size-3" />
            {designChip}
          </Chip>
        ) : null}
      </div>
      <div className={`flex items-center gap-1.5 ${TAP_ROW}`}>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown
            aria-hidden="true"
            className={`size-3.5 transition-transform${open ? ' rotate-180' : ''}`}
          />
          {open ? 'Collapse' : 'Expand'}
        </Button>
        <NextLink
          href={href}
          className={`${buttonClassName({ variant: 'ghost', size: 'sm' })} ms-auto`}
        >
          Open stack
        </NextLink>
      </div>
      {open ? (
        <div
          id={bodyId}
          className="flex flex-col gap-2 border-line border-t pt-2"
        >
          {stackStages(item).map((stage, i) => (
            <div key={stage.position} className="flex flex-col gap-1.5">
              {i > 0 ? (
                <p className="text-center text-xs text-ink-3">
                  after all of Stage {i}
                </p>
              ) : null}
              <div
                className={`flex items-center gap-1.5 text-xs font-semibold ${
                  stage.position === stack.currentStage
                    ? 'text-accent-ink'
                    : 'text-ink-2'
                }`}
              >
                <span className="flex size-4 items-center justify-center rounded-full bg-hover tabular-nums">
                  {stage.position + 1}
                </span>
                {stage.name}
                <span className="ms-auto font-normal text-ink-3 tabular-nums">
                  {stage.accepted} / {stage.cards.length + stage.missing.length}
                </span>
              </div>
              {stage.cards.map((card) => (
                <StackCard
                  key={card.id}
                  card={card}
                  canOperate={canOperate}
                  actions={actions}
                  onOpen={onOpenCard}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One card inside an expanded stack: its own column, state and Run. */
function StackCard({
  card,
  canOperate,
  actions,
  onOpen,
}: {
  card: BoardCardView;
  canOperate: boolean;
  actions: CardActions;
  onOpen: (card: BoardCardView) => void;
}) {
  const pill = card.column === 'completed' ? null : roundPill(card.round);
  const cost = formatCost(card.costUsd);
  const after = dependencyChip(card.dependsOn);
  const gate = card.stack?.gate ?? null;
  const runnable = canOperate && (canRun(card) || canRetry(card));
  return (
    <article className="flex min-w-0 flex-col gap-1 rounded-control bg-hover px-2.5 py-2">
      <div className="flex h-4 min-w-0 items-center gap-1.5 whitespace-nowrap text-xs leading-4 text-ink-2">
        <span className="shrink-0 font-mono">{card.label}</span>
        {card.design?.needed ? (
          <Chip size="sm" className={HEAD_CHIP}>
            Design
          </Chip>
        ) : null}
        {after ? (
          <Chip
            size="sm"
            tone={after.open ? 'warn' : 'neutral'}
            title={after.title}
            className="h-4 min-w-0 shrink"
          >
            <span className="truncate">{after.text}</span>
          </Chip>
        ) : null}
        {cost ? <span className="ms-auto tabular-nums">{cost}</span> : null}
      </div>
      <button
        type="button"
        className={`${TAP} break-words text-left font-medium underline-offset-2 hover:underline`}
        onClick={() => onOpen(card)}
      >
        {card.title}
      </button>
      <div
        className={`flex flex-wrap items-center gap-1.5${runnable ? ` ${TAP_ROW}` : ''}`}
      >
        <Chip size="sm">{COLUMN_TITLE[card.column]}</Chip>
        {card.column === 'completed' ? (
          <StatusPill size="sm" status="done" label="Accepted" />
        ) : pill ? (
          <StatusPill size="sm" status={pill.status} label={pill.label} />
        ) : null}
        {runnable ? (
          gate ? (
            <Tooltip content={gate}>
              <span className="ms-auto">
                <Button
                  size="sm"
                  variant="glass"
                  disabled
                  aria-label={`Run ${card.label}: ${gate}`}
                >
                  Run
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button
              size="sm"
              variant="glass"
              className="ms-auto"
              disabled={actions.busy}
              onClick={() => void actions.run(card)}
            >
              {canRetry(card) ? 'Run again' : 'Run'}
            </Button>
          )
        ) : null}
      </div>
    </article>
  );
}
