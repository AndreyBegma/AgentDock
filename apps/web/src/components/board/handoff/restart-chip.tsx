import { type BoardCardView, restartChipLabel } from '@agentdock/shared';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';

/**
 * #449 D9: how the latest round's session started — `resumed from handoff ·
 * saved ≈ $x` after a fresh start seeded with the note, `resumed session`
 * after `--resume`, nothing for a first round.
 */
export function RestartChip({
  card,
}: {
  card: Pick<BoardCardView, 'restartMode' | 'warmupSavedUsd'>;
}) {
  const label = restartChipLabel(card.restartMode, card.warmupSavedUsd);
  if (label === null) return null;
  const fresh = card.restartMode === 'fresh';
  return (
    <Tooltip
      content={
        fresh
          ? 'The runner started a new session from the handoff note, the diff and the checklist because resuming the old one would have cost more. The old session is kept.'
          : 'The runner resumed the card’s Claude session.'
      }
    >
      <span>
        <Chip
          size="sm"
          tone={fresh ? 'ok' : undefined}
          data-restart-chip={card.restartMode}
        >
          {label}
        </Chip>
      </span>
    </Tooltip>
  );
}
