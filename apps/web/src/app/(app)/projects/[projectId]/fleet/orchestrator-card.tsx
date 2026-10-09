import {
  type FleetView,
  projectRoleAtLeast,
  type Role,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { Tooltip } from 'glass-ui/tooltip';
import {
  channelChip,
  formatAge,
  formatOccupancy,
  formatRoundHeader,
  ORCHESTRATOR_TONE,
} from '../../../../../lib/fleet/format';
import { OrchestratorControls } from './orchestrator-controls';

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-ink-2">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

export function OrchestratorCard({
  fleet,
  projectId,
  control,
  role,
  onAttach,
}: {
  fleet: FleetView;
  projectId: string;
  control: Parameters<typeof OrchestratorControls>[0]['control'];
  role: Role;
  /** Admins on a runner that can attach; absent hides the action. */
  onAttach?: () => void;
}) {
  const { orchestrator, latestRound, boardError } = fleet;
  const channel = channelChip(fleet.fleetChannel);
  return (
    <Card pad="md" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">Orchestrator</h2>
        <span className="inline-flex items-center gap-2 text-sm">
          <Badge
            dot
            tone={ORCHESTRATOR_TONE[orchestrator.status]}
            aria-hidden="true"
          />
          {orchestrator.status}
          {orchestrator.since ? (
            <span className="text-ink-3">
              · {formatAge(orchestrator.since)}
            </span>
          ) : null}
        </span>
        <Tooltip content={channel.tooltip}>
          <button type="button" className="cursor-help">
            <Badge tone={channel.tone} label={channel.label} />
          </button>
        </Tooltip>
      </div>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Fact label="Base" value={fleet.base} />
        <Fact label="Slots" value={formatOccupancy(latestRound)} />
        <Fact
          label="Last round"
          value={
            latestRound
              ? formatRoundHeader(latestRound.date, latestRound.label)
              : '—'
          }
        />
        <Fact label="Session" value={orchestrator.session ?? '—'} />
      </dl>
      {onAttach && orchestrator.status !== 'absent' ? (
        <div>
          <Button variant="glass" size="sm" onClick={onAttach}>
            Attach
          </Button>
        </div>
      ) : null}
      <OrchestratorControls
        projectId={projectId}
        control={control}
        canOperate={projectRoleAtLeast(role, 'operator')}
        isAdmin={role === 'admin'}
      />
      {boardError ? (
        <p role="alert" className="text-sm text-warn">
          The latest board could not be read: {boardError.reason} (
          {boardError.file}
          {boardError.line ? `:${boardError.line}` : ''})
        </p>
      ) : null}
    </Card>
  );
}
