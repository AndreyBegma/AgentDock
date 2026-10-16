import {
  type BoardCardView,
  BULK_CARD_ACTIONS,
  type BulkCardAction,
} from '@agentdock/shared';
// glass-ui 0.34.0 exports `SelectionBar` from the barrel only — its package.json
// has no `./selection-bar` subpath. Move to the subpath once glass-ui adds it.
import { SelectionBar, type SelectionBarAction } from '@andrewbehma/glass-ui';
import { BULK_ACTION_LABEL, planBulk } from '../../lib/board/selection';

/**
 * #452: the floating action bar — glass-ui's `SelectionBar`, handed the count
 * and the four actions. Each action says how many of the selection it applies
 * to ("40 of 42", counted with the rule the API runs); the bar disables it at 0.
 */
export function bulkBarActions(
  selected: readonly BoardCardView[],
  busy: boolean,
  onAction: (action: BulkCardAction) => void,
): SelectionBarAction[] {
  return BULK_CARD_ACTIONS.map((action) => ({
    id: action,
    label: BULK_ACTION_LABEL[action],
    count: planBulk(action, selected).applies.length,
    of: selected.length,
    tone: action === 'delete' ? 'danger' : 'glass',
    disabled: busy,
    onSelect: () => onAction(action),
  }));
}

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
    <SelectionBar
      aria-label="Bulk actions"
      count={selected.length}
      onClear={onClear}
      actions={bulkBarActions(selected, busy, onAction)}
    />
  );
}
