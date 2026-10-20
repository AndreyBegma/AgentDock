'use client';

import type { FleetView } from '@agentdock/shared';
import { Section } from '@andrewbehma/glass-ui/section';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Network } from 'lucide-react';
import {
  formatAge,
  formatRoundHeader,
  ORCHESTRATOR_STATUS_LABEL,
} from '../../../../../lib/fleet/format';
import { ORCHESTRATOR_PILL_STATUS } from '../../../../../lib/status/pill';

/**
 * The orchestrator as one row above the slots (C-283): its state, how long it
 * has been so and the latest round. Opening it shows the orchestrator card —
 * messages, start and stop — in the sheet the page already has.
 */
export function OrchestratorRow({
  fleet,
  selected,
  onOpen,
}: {
  fleet: FleetView;
  selected: boolean;
  onOpen: () => void;
}) {
  const { status, since } = fleet.orchestrator;
  const round = fleet.latestRound;
  return (
    <Section title="Orchestrator" pad="none">
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        className={`flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-start hover:bg-hover ${
          selected ? 'bg-accent-soft' : ''
        }`}
        onClick={onOpen}
      >
        <Network aria-hidden="true" className="size-4 shrink-0 text-ink-2" />
        <span className="min-w-0 flex-1 text-sm">
          <span className="block font-medium">Orchestrator</span>
          <span className="block truncate text-xs text-ink-3">
            {round
              ? `Round ${formatRoundHeader(round.date, round.label)} · ${fleet.base}`
              : `No round yet · ${fleet.base}`}
          </span>
        </span>
        <StatusPill
          size="md"
          status={ORCHESTRATOR_PILL_STATUS[status]}
          label={
            since && status !== 'unknown'
              ? `${ORCHESTRATOR_STATUS_LABEL[status]} · ${formatAge(since)}`
              : ORCHESTRATOR_STATUS_LABEL[status]
          }
        />
      </button>
    </Section>
  );
}
