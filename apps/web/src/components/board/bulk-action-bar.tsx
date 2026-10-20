// glass-ui 0.34.0 exports `SelectionBar` from the barrel only — its package.json
// has no `./selection-bar` subpath. Move to the subpath once glass-ui adds it.
import { SelectionBar, type SelectionBarAction } from '@andrewbehma/glass-ui';
import {
  type BoardCardView,
  BULK_CARD_ACTIONS,
  type BulkCardAction,
} from '@nautelle/shared';
import { BULK_ACTION_LABEL, planBulk } from '../../lib/board/selection';
import { planGroup } from '../../lib/board/stacks';

/** #588: the bar's action that groups the selection into a new stack. */
export const GROUP_ACTION = 'group';

/**
 * #452: the floating action bar — glass-ui's `SelectionBar`, handed the count
 * and the actions. Each action says how many of the selection it applies to
 * ("40 of 42", counted with the rule the API runs); the bar disables it at 0.
 * #588: Group into stack comes first, when `onGroup` is given, and needs two
 * cards that can join.
 */
export function bulkBarActions(
  selected: readonly BoardCardView[],
  busy: boolean,
  onAction: (action: BulkCardAction) => void,
  onGroup?: () => void,
): SelectionBarAction[] {
  const group = planGroup(selected);
  const grouping: SelectionBarAction[] = onGroup
    ? [
        {
          id: GROUP_ACTION,
          label: 'Group into stack',
          count: group.joins.length,
          of: selected.length,
          tone: 'glass',
          disabled: busy || !group.ready,
          onSelect: onGroup,
        },
      ]
    : [];
  const bulk = BULK_CARD_ACTIONS.map(
    (action): SelectionBarAction => ({
      id: action,
      label: BULK_ACTION_LABEL[action],
      count: planBulk(action, selected).applies.length,
      of: selected.length,
      tone: action === 'delete' ? 'danger' : 'glass',
      disabled: busy,
      onSelect: () => onAction(action),
    }),
  );
  return [...grouping, ...bulk];
}

export function BulkActionBar({
  selected,
  busy,
  onClear,
  onAction,
  onGroup,
}: {
  selected: readonly BoardCardView[];
  busy: boolean;
  onClear: () => void;
  onAction: (action: BulkCardAction) => void;
  onGroup?: () => void;
}) {
  return (
    <SelectionBar
      aria-label="Bulk actions"
      count={selected.length}
      onClear={onClear}
      actions={bulkBarActions(selected, busy, onAction, onGroup)}
    />
  );
}
