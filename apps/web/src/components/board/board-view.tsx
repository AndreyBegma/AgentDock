'use client';

import type {
  BoardCardView,
  BoardPlanTaskView,
  BoardView,
} from '@agentdock/shared';
import { Board, type BoardColumn } from '@andrewbehma/glass-ui/board';
import { Button } from '@andrewbehma/glass-ui/button';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { MenuItem, MenuSeparator } from '@andrewbehma/glass-ui/menu';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useRouter } from 'next/navigation';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import {
  applyDrop,
  clampDropIndex,
  type DropMove,
  decideDrop,
} from '../../lib/board/board-state';
import {
  type BoardFilter,
  isFiltering,
  matchesFilter,
  unfilteredIndex,
} from '../../lib/board/filter';
import {
  approveRunOffer,
  COLUMN_HINT,
  COLUMN_TITLE,
  canAccept,
  canDelete,
  canGiveFeedback,
  canMarkFinished,
  canRetry,
  canRun,
  canStop,
  columnsOf,
  isSuggestion,
} from '../../lib/board/format';
import { boardStackPageHref } from '../../lib/board/href';
import { boardItems, isPlanItem } from '../../lib/board/plan-tasks';
import {
  type CardSelection,
  columnSelection,
  NO_SELECTION,
  pruned,
  selectableNumbers,
  toggled,
  toggledColumn,
  withAll,
  withRange,
} from '../../lib/board/selection';
import {
  type ColumnItem,
  foldStacks,
  isStackItem,
  withoutStacks,
} from '../../lib/board/stacks';
import { cardDesignHref } from '../../lib/design/href';
import { planHref } from '../../lib/planner/href';
import { boardColumnWidth, usePhone, visibleColumns } from './board-layout';
import { BulkActionBar } from './bulk-action-bar';
import { CardFace } from './card-face';
import { GroupStackDialog } from './group-stack-dialog';
import { MovePicker } from './move-picker';
import { PlanTaskFace } from './plan-task-face';
import { StackFace } from './stack-face';
import { useBulkActions } from './use-bulk-actions';
import type { CardActions } from './use-card-actions';
import { useCardMove } from './use-card-move';

/** C-29: Completed starts folded to a strip; the work in flight gets the width. */
const FOLDED_AT_START = ['completed'];

/** Older Completed pages, fetched by the page; offered in Completed's footer. */
export interface OlderCompleted {
  loading: boolean;
  onLoad: () => void;
}

/**
 * The Board (D7). It is controlled: a drop is checked with `boardMoveRule`,
 * shown at once, and sent; a refusal from the server rolls it back with a toast.
 * glass-ui's `Board` has no `canDrop`, so a drop that is not allowed is
 * declined here, in `onMove`. A plan task is `movable: false`, so neither the
 * drag nor the menu can produce a move for it (C-44).
 */
export function BoardColumns({
  projectId,
  view,
  planTasks,
  runnerName,
  canOperate,
  canTerminal,
  actions,
  filter,
  olderCompleted,
  hints,
  onOpen,
  onOpenPlanTask,
  onOpenTerminal,
  onReload,
}: {
  projectId: string;
  view: BoardView;
  /** #270: read-only plan tasks, after the cards of their column (D4). */
  planTasks: readonly BoardPlanTaskView[];
  runnerName?: string | null;
  canOperate: boolean;
  canTerminal: boolean;
  actions: CardActions;
  /** C-29: what the toolbar hides; a hidden card is still in the column. */
  filter: BoardFilter;
  /** Set while the server has older Completed cards than the board holds. */
  olderCompleted?: OlderCompleted;
  /** #660: triage hints waiting on a card, by card number. */
  hints?: ReadonlyMap<number, number>;
  onOpen: (card: BoardCardView) => void;
  onOpenPlanTask: (task: BoardPlanTaskView) => void;
  onOpenTerminal: (card: BoardCardView) => void;
  onReload: () => void;
}) {
  const router = useRouter();
  // The drop shown before the server answers.
  const [optimistic, setOptimistic] = useState<BoardView>();
  const [moving, setMoving] = useState<BoardCardView>();
  const [collapsed, setCollapsed] = useState<string[]>(FOLDED_AT_START);
  const shown = optimistic ?? view;

  const move = useCardMove({
    projectId,
    runnerName,
    canOperate,
    actions,
    onStart: (m) => setOptimistic(applyDrop(view, m)),
    // Server truth either way: on a refusal this is the rollback.
    onSettled: () => {
      setOptimistic(undefined);
      onReload();
    },
  });
  const busy = move.busy;

  const phone = usePhone();

  // #452: cards selected for a bulk action, across columns.
  const [selection, setSelection] = useState<CardSelection>(NO_SELECTION);
  // #588: the Group into stack dialog, over the selection.
  const [grouping, setGrouping] = useState(false);
  const anchor = useRef<{ number: number; column: string } | undefined>(
    undefined,
  );
  const pointerColumn = useRef<string | undefined>(undefined);
  const bulk = useBulkActions({
    projectId,
    runnerName,
    onSettled: (results) => {
      // What is left selected: the cards that were not done.
      const left = new Set(
        results.filter((r) => r.status !== 'done').map((r) => r.number),
      );
      setSelection(
        (current) => new Set([...current].filter((n) => left.has(n))),
      );
      onReload();
    },
  });
  const selectedCards = view.columns.flatMap((c) =>
    c.cards.filter((card) => selection.has(card.number)),
  );

  // A selected card that leaves the board drops out of the selection.
  useEffect(() => {
    const onBoard = new Set(
      view.columns.flatMap((c) => c.cards.map((x) => x.number)),
    );
    setSelection((current) => pruned(current, onBoard));
  }, [view]);

  const clearSelection = () => {
    setSelection(NO_SELECTION);
    anchor.current = undefined;
  };

  // Esc clears the selection; ⌘/Ctrl+A selects the column under the pointer or
  // focus, unless the person is typing.
  const hasSelection = selection.size > 0;
  useEffect(() => {
    if (!canOperate) return;
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    const overlay = () =>
      document.querySelector(
        '[role="dialog"], [role="alertdialog"], [role="menu"]',
      ) !== null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && hasSelection) {
        if (overlay() || event.defaultPrevented) return;
        clearSelection();
        return;
      }
      if (
        (event.key === 'a' || event.key === 'A') &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey
      ) {
        if (typing(event.target) || overlay()) return;
        const focused =
          document.activeElement instanceof HTMLElement
            ? document.activeElement.closest<HTMLElement>(
                '[data-select-column]',
              )?.dataset.selectColumn
            : undefined;
        const id = pointerColumn.current ?? focused;
        const column = allColumns.find((c) => c.id === id);
        if (!column) return;
        event.preventDefault();
        setSelection((current) =>
          withAll(current, selectableNumbers(withoutStacks(column.cards))),
        );
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const toggleCard = (card: BoardCardView, range: boolean) => {
    const order = selectableNumbers(
      withoutStacks(allColumns.find((c) => c.id === card.column)?.cards ?? []),
    );
    const from = anchor.current;
    setSelection((current) =>
      range && from?.column === card.column
        ? withRange(current, order, from.number, card.number)
        : toggled(current, card.number),
    );
    anchor.current = { number: card.number, column: card.column };
  };

  const items = boardItems(shown, planTasks);
  const filtering = isFiltering(filter);
  const allColumns: BoardColumn<ColumnItem>[] = columnsOf(shown).map((c) => {
    const all = items.get(c.column) ?? [];
    const matching = filtering
      ? all.filter((item) => matchesFilter(item, filter))
      : all;
    // #480: a stack's cards in its column fold into the stack's face.
    const cards = foldStacks(matching, c.column, shown, filtering);
    const older = c.column === 'completed' ? olderCompleted : undefined;
    return {
      id: c.column,
      title: COLUMN_TITLE[c.column],
      // `shown/total` while a filter hides some of the column.
      count: filtering ? `${cards.length}/${all.length}` : undefined,
      header: canOperate ? (
        <ColumnSelectAll
          column={c.column}
          title={COLUMN_TITLE[c.column]}
          order={selectableNumbers(withoutStacks(cards))}
          selection={selection}
          onToggle={(order) => setSelection((cur) => toggledColumn(cur, order))}
        />
      ) : undefined,
      cards,
      footer:
        cards.length === 0 || older ? (
          <>
            {all.length === 0 ? (
              <p className="px-1 text-xs text-ink-3">{COLUMN_HINT[c.column]}</p>
            ) : cards.length === 0 ? (
              <p className="px-1 text-xs text-ink-3">No cards match.</p>
            ) : null}
            {older ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={older.loading}
                onClick={older.onLoad}
              >
                {older.loading ? 'Loading…' : 'Show older completed cards'}
              </Button>
            ) : null}
          </>
        ) : c.column === 'inbox' && canOperate && !filtering ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={actions.busy || busy}
            onClick={() => actions.askDismissAll(c.cards.length)}
          >
            Dismiss all
          </Button>
        ) : undefined,
    };
  });

  const columnCounts = Object.fromEntries(
    shown.columns.map((c) => [c.column, c.cards.length]),
  );
  const columns = visibleColumns(allColumns, phone);
  const folded = columns.filter((c) => collapsed.includes(c.id)).length;

  /**
   * Under a filter — or beside a folded stack (#480) — the board reports an
   * index among the visible items; a stack stands for its first folded card.
   */
  const withFullIndex = (dropped: DropMove): DropMove => {
    const target = allColumns.find((c) => c.id === dropped.toColumnId);
    const stacked = target?.cards.some(isStackItem) ?? false;
    if (!filtering && !stacked) return dropped;
    const full = view.columns
      .find((c) => c.column === dropped.toColumnId)
      ?.cards.filter((c) => c.id !== dropped.id)
      .map((c) => c.id);
    const visible = target?.cards
      .filter((c) => c.id !== dropped.id)
      .flatMap((c) => (isStackItem(c) ? c.foldedIds.slice(0, 1) : [c.id]));
    if (!full || !visible) return dropped;
    return { ...dropped, index: unfilteredIndex(full, visible, dropped.index) };
  };

  const onMove = (dropped: DropMove) => {
    if (!canOperate) {
      toast.error('Only operators can move cards.');
      return;
    }
    move.decide(decideDrop(view, clampDropIndex(view, withFullIndex(dropped))));
  };

  return (
    <>
      {/*
       * Fills the height the page leaves; glass-ui's `Board` scrolls each column in it.
       * Its card `li` sets a min height but no `shrink-0`, so in a bounded column the
       * cards squash to one row instead of scrolling (#384) — kept here until glass-ui
       * ships the fix (glass-ui#147; docs/ui/glass-ui.md).
       */}
      <div
        className="flex min-h-0 flex-1 flex-col [&_[data-board-card]]:shrink-0"
        onPointerOver={(event) => {
          pointerColumn.current = (
            event.target as HTMLElement
          ).closest<HTMLElement>('[data-select-column]')?.dataset.selectColumn;
        }}
        onPointerLeave={() => {
          pointerColumn.current = undefined;
        }}
        style={
          {
            '--board-column': boardColumnWidth(columns.length - folded, folded),
          } as CSSProperties
        }
      >
        <Board<ColumnItem>
          className="flex-1 pb-0.5"
          aria-label="Project board"
          columns={columns}
          collapsible
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          onMove={onMove}
          // C-35: the menu trigger sits at the end of the face's header row
          // instead of taking a column; every face must place `menu`.
          menuPlacement="inline"
          renderCard={(item, _column, { menu }) =>
            isStackItem(item) ? (
              <StackFace
                projectId={projectId}
                item={item}
                canOperate={canOperate}
                actions={actions}
                menu={menu}
                onOpenCard={onOpen}
              />
            ) : isPlanItem(item) ? (
              <PlanTaskFace
                task={item.planTask}
                menu={menu}
                selecting={canOperate && selection.size > 0}
                onOpen={onOpenPlanTask}
              />
            ) : (
              <CardFace
                projectId={projectId}
                card={item.card}
                canOperate={canOperate}
                hints={hints?.get(item.card.number)}
                menu={menu}
                selection={
                  canOperate
                    ? {
                        selected: selection.has(item.card.number),
                        selecting: selection.size > 0,
                        onToggle: (range) => toggleCard(item.card, range),
                      }
                    : undefined
                }
                onOpen={onOpen}
              />
            )
          }
          renderCardMenu={(item) => {
            if (isStackItem(item)) {
              // Not movable: the stack follows its cards.
              return (
                <MenuItem
                  onSelect={() =>
                    router.push(
                      boardStackPageHref(projectId, item.stack.number),
                    )
                  }
                >
                  Open stack
                </MenuItem>
              );
            }
            if (isPlanItem(item)) {
              const task = item.planTask;
              // Not movable: no move entries above, so no separator either.
              return (
                <>
                  <MenuItem onSelect={() => onOpenPlanTask(task)}>
                    Open
                  </MenuItem>
                  <MenuItem
                    onSelect={() =>
                      router.push(planHref(projectId, task.planId, task.key))
                    }
                  >
                    Open in Planner
                  </MenuItem>
                </>
              );
            }
            const card = item.card;
            if (isSuggestion(card)) {
              return (
                <>
                  <MenuSeparator />
                  <MenuItem onSelect={() => onOpen(card)}>Open</MenuItem>
                  {canOperate ? (
                    <>
                      <MenuItem
                        disabled={actions.busy || busy}
                        onSelect={() => void actions.acceptSuggestion(card)}
                      >
                        Accept
                      </MenuItem>
                      <MenuItem onSelect={() => onOpen(card)}>
                        Edit & accept…
                      </MenuItem>
                      <MenuItem
                        tone="danger"
                        disabled={actions.busy || busy}
                        onSelect={() => void actions.dismiss(card)}
                      >
                        Dismiss
                      </MenuItem>
                    </>
                  ) : null}
                </>
              );
            }
            return (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => onOpen(card)}>Open</MenuItem>
                {canOperate ? (
                  <MenuItem onSelect={() => setMoving(card)}>Move…</MenuItem>
                ) : null}
                {canOperate && (canRun(card) || canRetry(card)) ? (
                  <MenuItem
                    // #480: the stack's design holds Run; the label says why.
                    disabled={actions.busy || busy || !!card.stack?.gate}
                    onSelect={() => actions.run(card)}
                  >
                    {canRetry(card) ? 'Run again' : 'Run'}
                    {card.stack?.gate
                      ? ` — ${card.stack.gate.toLowerCase()}`
                      : ''}
                  </MenuItem>
                ) : null}
                {canOperate && approveRunOffer(card) ? (
                  <MenuItem
                    disabled={!approveRunOffer(card)?.enabled}
                    onSelect={() =>
                      router.push(cardDesignHref(projectId, card.number))
                    }
                  >
                    Approve & run
                  </MenuItem>
                ) : null}
                {canOperate && canMarkFinished(card) ? (
                  <MenuItem onSelect={() => actions.markFinished(card)}>
                    Mark finished
                  </MenuItem>
                ) : null}
                {canOperate && canGiveFeedback(card) ? (
                  <MenuItem onSelect={() => onOpen(card)}>Feedback…</MenuItem>
                ) : null}
                {canOperate && canAccept(card) ? (
                  <MenuItem onSelect={() => actions.accept(card)}>
                    Accept
                  </MenuItem>
                ) : null}
                {canTerminal && card.round !== null ? (
                  <MenuItem onSelect={() => onOpenTerminal(card)}>
                    Open terminal
                  </MenuItem>
                ) : null}
                {canOperate && canStop(card) ? (
                  <MenuItem
                    tone="danger"
                    onSelect={() => actions.askStop(card)}
                  >
                    Stop worker
                  </MenuItem>
                ) : null}
                {canOperate && canDelete(card) ? (
                  <MenuItem
                    tone="danger"
                    onSelect={() => actions.askDelete(card)}
                  >
                    Delete
                  </MenuItem>
                ) : null}
              </>
            );
          }}
        />
      </div>

      {bulk.dialogs}
      {canOperate ? (
        <BulkActionBar
          selected={selectedCards}
          busy={bulk.busy || busy}
          onClear={clearSelection}
          onAction={(action) => bulk.run(action, selectedCards)}
          onGroup={() => setGrouping(true)}
        />
      ) : null}
      <GroupStackDialog
        projectId={projectId}
        cards={selectedCards}
        open={grouping}
        onOpenChange={setGrouping}
        onGrouped={(stack) => {
          setGrouping(false);
          clearSelection();
          onReload();
          toast.success(`Grouped ${stack.total} cards into ${stack.label}`, {
            description: `${stack.title} · one stage, ${stack.design ? 'shared design waits for approval' : 'no shared design'}. Each card still runs on its own.`,
            action: {
              label: 'Open stack',
              onClick: () =>
                router.push(boardStackPageHref(projectId, stack.number)),
            },
          });
        }}
      />

      {move.dialogs}
      {moving ? (
        <MovePicker
          card={moving}
          counts={columnCounts}
          open
          onOpenChange={(open) => {
            if (!open) setMoving(undefined);
          }}
          onPick={(column) => move.moveTo(moving, column)}
        />
      ) : null}
    </>
  );
}

/**
 * #452: a column header's "Select all". It takes only the cards the filter
 * shows and reads "n of m" while the column is partly selected.
 */
function ColumnSelectAll({
  column,
  title,
  order,
  selection,
  onToggle,
}: {
  column: string;
  title: string;
  /** The selectable cards the column shows, in order. */
  order: readonly number[];
  selection: CardSelection;
  onToggle: (order: readonly number[]) => void;
}) {
  if (order.length === 0) return null;
  const { selected, total, state } = columnSelection(order, selection);
  return (
    <span
      data-select-column={column}
      className="ms-auto flex items-center text-xs text-ink-3"
      title={`Selects the ${total} selectable card${total === 1 ? '' : 's'} shown in ${title}`}
    >
      <Checkbox
        aria-label={`Select all in ${title}`}
        label={state === 'some' ? `${selected} of ${total}` : 'Select all'}
        checked={state === 'all'}
        indeterminate={state === 'some'}
        onChange={() => onToggle(order)}
      />
    </span>
  );
}
