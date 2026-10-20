'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { StatusDot } from '@andrewbehma/glass-ui/status-pill';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import type {
  FleetView,
  OrchestratorSettingsView,
  OrchestratorStatus,
} from '@nautelle/shared';
import type { ReactNode } from 'react';
import { PrerequisiteBanner } from '../../../../../components/prerequisites/prerequisite-banner';
import { orchestratorSettingsHref } from '../../../../../lib/control/reasons';
import {
  CHANNEL_EXPLANATION,
  channelChip,
  FLEET_FACT_HINT,
  formatAge,
  formatOccupancy,
  formatRoundHeader,
  ORCHESTRATOR_STATUS_HINT,
  ORCHESTRATOR_STATUS_LABEL,
  showStopControl,
} from '../../../../../lib/fleet/format';
import type { Section } from '../../../../../lib/section/use-section';
import { ORCHESTRATOR_PILL_STATUS } from '../../../../../lib/status/pill';
import { OrchestratorControls } from './orchestrator-controls';
import type { ControlReasons } from './use-control-reasons';

/** A label with a one-line explanation, reachable by keyboard as well as by mouse. */
function Fact({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-ink-2">
        <Tooltip content={hint}>
          <button type="button" className="cursor-help">
            {label}
          </button>
        </Tooltip>
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function OrchestratorCard({
  fleet,
  projectId,
  control,
  canOperate,
  isAdmin,
  settings,
  reasons,
  showStart,
  onStart,
  onAttach,
}: {
  fleet: FleetView;
  projectId: string;
  control: Parameters<typeof OrchestratorControls>[0]['control'];
  canOperate: boolean;
  isAdmin: boolean;
  settings: Section<OrchestratorSettingsView>;
  reasons: ControlReasons;
  /** False on an empty fleet: the first-project checklist holds the Start. */
  showStart: boolean;
  onStart: () => void;
  /** Admins on a runner that can attach; absent hides the action. */
  onAttach?: () => void;
}) {
  const { orchestrator, latestRound } = fleet;
  const channel = channelChip(fleet.fleetChannel);
  const channelNote = CHANNEL_EXPLANATION[fleet.fleetChannel];
  const status: OrchestratorStatus = orchestrator.status;
  // On an empty fleet the checklist's first step says this; not twice.
  const profileMissing = showStart && settings.data?.effectiveProfile === null;
  return (
    <Card pad="md" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">Orchestrator</h2>
        <span className="inline-flex items-center gap-2 text-sm">
          <StatusDot status={ORCHESTRATOR_PILL_STATUS[status]} />
          <Tooltip content={ORCHESTRATOR_STATUS_HINT[status]}>
            <button type="button" className="cursor-help">
              {ORCHESTRATOR_STATUS_LABEL[status]}
            </button>
          </Tooltip>
          {orchestrator.since ? (
            <span className="text-ink-3">
              · {formatAge(orchestrator.since)}
            </span>
          ) : null}
        </span>
        <Tooltip content={channel.tooltip}>
          <button
            type="button"
            className="cursor-help"
            aria-label={`Where the facts come from: ${channel.label}`}
          >
            <Badge tone={channel.tone} label={channel.label} />
          </button>
        </Tooltip>
      </div>
      {channelNote ? (
        <p className="max-w-prose text-xs text-ink-3">{channelNote}</p>
      ) : null}
      {profileMissing ? (
        <PrerequisiteBanner
          tone="warn"
          title="No runtime profile is set for this project."
          body="The orchestrator cannot start without one."
          href={orchestratorSettingsHref(projectId)}
          cta="Choose a profile"
        />
      ) : null}
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Fact label="Base" hint={FLEET_FACT_HINT.base}>
          {fleet.base}
        </Fact>
        <Fact label="Slots" hint={FLEET_FACT_HINT.slots}>
          {formatOccupancy(fleet.slots.length, latestRound)}
        </Fact>
        <Fact label="Last round" hint={FLEET_FACT_HINT.lastRound}>
          {latestRound
            ? formatRoundHeader(latestRound.date, latestRound.label)
            : '—'}
        </Fact>
        <Fact label="Session" hint={FLEET_FACT_HINT.session}>
          {orchestrator.session ?? '—'}
        </Fact>
      </dl>
      {onAttach && status !== 'absent' ? (
        <div>
          <Button variant="glass" size="sm" onClick={onAttach}>
            Attach
          </Button>
        </div>
      ) : null}
      <OrchestratorControls
        projectId={projectId}
        control={control}
        canOperate={canOperate}
        isAdmin={isAdmin}
        settings={settings.data}
        reasons={reasons}
        showStop={showStopControl(status)}
        showStart={showStart}
        onStart={onStart}
      />
      {/* The board's error is the page's one banner (#213); this card does not repeat it. */}
    </Card>
  );
}
