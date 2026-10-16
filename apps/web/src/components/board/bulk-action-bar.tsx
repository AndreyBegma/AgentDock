import {
  type BoardCardView,
  BULK_CARD_ACTIONS,
  type BulkCardAction,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import {
  appliesLabel,
  BULK_ACTION_LABEL,
  planBulk,
} from '../../lib/board/selection';

/**
 * #452: what the floating action bar holds while anything is selected — "N
 * selected", Clear, and the four actions. Each action says how many of the
 * selection it applies to ("40 of 42", counted with the rule the API runs) and
 * is disabled at 0. The bar's surface (glass-strong, fixed at the bottom
 * centre, the enter and exit) is glass-ui's `SelectionBar` (ADR-0011).
 */
export function BulkActionBar({
  selected,
  busy,
  onClear,
  onAction,
}: {
  selected: readonly BoardCardView[];
  busy: boolean;
  onClear: () => void;
  onAction: (action: BulkCardAction) => void;
}) {
  return (
    <>
      <span className="flex items-center gap-2 ps-1.5 pe-2 text-[13px] font-semibold whitespace-nowrap">
        <Badge size="md" label={String(selected.length)} />
        selected
      </span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>
        Clear
        <kbd className="ms-1.5 font-mono text-[11px] text-ink-3">Esc</kbd>
      </Button>
      <span aria-hidden="true" className="mx-1 w-px self-stretch bg-line" />
      {BULK_CARD_ACTIONS.map((action) => {
        const applies = planBulk(action, selected).applies.length;
        return (
          <Button
            key={action}
            variant={action === 'delete' ? 'danger' : 'glass'}
            size="sm"
            disabled={busy || applies === 0}
            title={
              applies === 0
                ? 'None of the selected cards can make this move'
                : undefined
            }
            onClick={() => onAction(action)}
          >
            {BULK_ACTION_LABEL[action]}
            <span className="ms-1.5 font-medium tabular-nums text-ink-3">
              {appliesLabel(applies, selected.length)}
            </span>
          </Button>
        );
      })}
    </>
  );
}
