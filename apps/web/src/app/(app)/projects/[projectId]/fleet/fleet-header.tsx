'use client';

import type { OrchestratorStatus } from '@agentdock/shared';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import {
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { MetaBar } from '@andrewbehma/glass-ui/meta-bar';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { LayoutGrid, Maximize, Settings } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { useLivePaused } from '../../../../../components/shell/live-status';
import { LiveStatusBadge } from '../../../../../components/shell/live-status-badge';
import { orchestratorSettingsHref } from '../../../../../lib/control/reasons';
import { ORCHESTRATOR_STATUS_LABEL } from '../../../../../lib/fleet/format';
import {
  type FleetCounts,
  fleetCounters,
} from '../../../../../lib/fleet/graph';
import type { WorkspaceView } from '../../../../../lib/fleet/workspace-url';
import { ORCHESTRATOR_PILL_STATUS } from '../../../../../lib/status/pill';

const VIEW_LABEL: Record<WorkspaceView, string> = {
  canvas: 'Agent tree',
  list: 'All slots (table)',
};

/**
 * The workspace's header (#160, #213): the shared `PageHeader`, the
 * orchestrator's state beside the title in the one vocabulary the card and
 * the canvas use, and the fleet's counters in `meta`.
 */
export function FleetHeader({
  projectId,
  title,
  orchestrator,
  counts,
  view,
  canOperate,
  newIssuePrimary,
  onNewIssue,
  onFit,
  onViewChange,
}: {
  projectId: string;
  title: string;
  orchestrator: OrchestratorStatus | undefined;
  counts: FleetCounts | undefined;
  view: WorkspaceView;
  canOperate: boolean;
  /**
   * New issue is the screen's one solid button, except on an empty fleet,
   * where the first-project checklist's Start is (#213).
   */
  newIssuePrimary: boolean;
  onNewIssue: () => void;
  /** Absent while there is no canvas to fit. */
  onFit?: () => void;
  onViewChange: (view: WorkspaceView) => void;
}) {
  const live = useLivePaused();
  // The top bar's dot says "live"; the page speaks up only when it is not.
  const notLive = live.status !== 'connected' || live.paused;
  return (
    <PageHeader
      className="mb-0"
      title={title}
      description="The orchestrator and the agents it runs on this project."
      {...(orchestrator
        ? {
            status: (
              <StatusPill
                status={ORCHESTRATOR_PILL_STATUS[orchestrator]}
                label={ORCHESTRATOR_STATUS_LABEL[orchestrator]}
              />
            ),
          }
        : {})}
      {...(counts
        ? { meta: <MetaBar counters={fleetCounters(counts)} /> }
        : {})}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {notLive ? <LiveStatusBadge /> : null}
          {canOperate ? (
            <Button
              variant={newIssuePrimary ? 'solid' : 'glass'}
              onClick={onNewIssue}
            >
              New issue
            </Button>
          ) : null}
          {onFit ? (
            <Tooltip content="Fit to view">
              <Button
                variant="ghost"
                icon
                aria-label="Fit to view"
                onClick={onFit}
              >
                <Maximize aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip content="Orchestrator settings">
            <Link
              href={orchestratorSettingsHref(projectId)}
              aria-label="Orchestrator settings"
              className={buttonClassName({ variant: 'ghost', icon: true })}
            >
              <Settings aria-hidden="true" className="size-4" />
            </Link>
          </Tooltip>
          <MenuRoot>
            <MenuTrigger asChild>
              <Button variant="ghost" icon aria-label="View">
                <LayoutGrid aria-hidden="true" className="size-4" />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>View</MenuLabel>
              <MenuRadioGroup
                value={view}
                onValueChange={(value) =>
                  onViewChange(value === 'list' ? 'list' : 'canvas')
                }
              >
                {(['canvas', 'list'] as const).map((v) => (
                  <MenuRadioItem key={v} value={v}>
                    {VIEW_LABEL[v]}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </MenuRoot>
        </div>
      }
    />
  );
}
