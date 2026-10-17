'use client';

import type { BoardCardView, BoardColumn } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Check } from 'lucide-react';
import { moveTargets } from '../../lib/board/board-state';
import { COLUMN_TITLE } from '../../lib/board/format';

/**
 * #515: the way to move a card without dragging it — a touch screen starts no
 * drag. A bottom sheet lists the card's own column (marked) and every column
 * the board rule lets it go to; a row is 52 px, never under the 44 px of a tap.
 * Choosing one is the same move the drag makes, so the caller decides, asks
 * and sends (`useCardMove`).
 */
export function MovePicker({
  card,
  counts,
  open,
  onOpenChange,
  onPick,
}: {
  card: BoardCardView;
  /** Cards per column, when the caller has the board. */
  counts?: Partial<Record<BoardColumn, number>>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (column: BoardColumn) => void;
}) {
  const targets = moveTargets(card);
  const row = (column: BoardColumn, current: boolean) => (
    <li key={column}>
      <Button
        variant="ghost"
        full
        aria-current={current ? 'true' : undefined}
        className={`h-13 justify-start gap-3 px-3 text-base ${current ? 'bg-accent-soft font-semibold text-accent-ink' : ''}`}
        onClick={() => {
          onOpenChange(false);
          if (!current) onPick(column);
        }}
      >
        <span className="flex-1 text-left">{COLUMN_TITLE[column]}</span>
        {current ? (
          <>
            <Check aria-hidden="true" className="size-4" />
            <span className="text-xs font-semibold">Current</span>
          </>
        ) : counts?.[column] !== undefined ? (
          <Badge tone="neutral" count={counts[column]} />
        ) : null}
      </Button>
    </li>
  );
  return (
    <SheetRoot open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        title={`Move ${card.label}`}
        description={card.title}
        footer={
          <Button variant="ghost" full onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        }
      >
        <ul aria-label="Columns" className="flex flex-col gap-0.5">
          {row(card.column, true)}
          {targets.map((column) => row(column, false))}
        </ul>
      </SheetContent>
    </SheetRoot>
  );
}
