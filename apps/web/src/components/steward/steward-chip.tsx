import { Chip } from '@andrewbehma/glass-ui/chip';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import {
  STEWARD_KIND_LABEL,
  type StewardCardChip,
  stewardChipLabel,
} from '@nautelle/shared';
import { TriangleAlert } from 'lucide-react';

/**
 * #447 D15: `Stuck: API error · nudged 1/2` while an incident of the card's
 * latest round is open; danger once Steward has escalated to a person.
 */
export function StewardChip({ chip }: { chip: StewardCardChip }) {
  const label = stewardChipLabel(chip);
  const escalated = chip.status === 'escalated';
  return (
    <Tooltip
      content={
        escalated
          ? `Steward could not fix this (${STEWARD_KIND_LABEL[chip.kind]}). Open the card for the history.`
          : 'Steward noticed this and is handling it. Open the card for the history.'
      }
    >
      <span>
        <Chip
          size="sm"
          tone={escalated ? 'danger' : 'warn'}
          className="gap-1"
          data-steward-chip={chip.status}
        >
          <TriangleAlert aria-hidden="true" className="size-3" />
          {label}
        </Chip>
      </span>
    </Tooltip>
  );
}
