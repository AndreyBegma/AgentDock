import type { QueueItemView } from '@agentdock/shared';
import { Board } from 'glass-ui/board';
import { type BoardCard, boardColumns } from '../../../../../lib/queue/format';
import { ComputedNote, IssueLink } from './state-cells';

/**
 * D11: five fixed columns, one per state. State comes from GitHub and the
 * orchestrator, so `onMove` does nothing — the board is controlled and the
 * columns are derived from `items`, a drop never sticks. glass-ui's Board has
 * no read-only mode yet (spec 19 notes).
 */
export function QueueBoard({
  items,
  onSelect,
}: {
  items: QueueItemView[];
  onSelect: (item: QueueItemView) => void;
}) {
  return (
    <Board<BoardCard>
      aria-label="Queue board"
      columns={boardColumns(items)}
      onMove={() => {}}
      renderCard={(card) => (
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-ink-2">
            <IssueLink item={card.item} />
          </span>
          <button
            type="button"
            className="text-left font-medium underline-offset-2 hover:underline"
            onClick={() => onSelect(card.item)}
          >
            {card.item.title}
          </button>
          {card.item.why ? (
            <span className="text-xs text-ink-2">{card.item.why}</span>
          ) : null}
          <ComputedNote item={card.item} />
        </div>
      )}
    />
  );
}
