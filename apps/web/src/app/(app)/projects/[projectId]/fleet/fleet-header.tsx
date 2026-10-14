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
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { LayoutGrid, Maximize, Network, Settings } from 'lucide-react';
import Link from 'next/link';
import { LiveStatusBadge } from '../../../../../components/shell/live-status-badge';
import { orchestratorSettingsHref } from '../../../../../lib/control/reasons';
import {
  type FleetCounts,
  fleetCounters,
  ORCHESTRATOR_HEADER_STATUS,
  ORCHESTRATOR_PILL_LABEL,
} from '../../../../../lib/fleet/graph';
import type { WorkspaceView } from '../../../../../lib/fleet/workspace-url';

const VIEW_LABEL: Record<WorkspaceView, string> = {
  canvas: 'Agent tree',
  list: 'All slots (table)',
};

/** The workspace's header (#160): who, how it is doing, and what to do next. */
export function FleetHeader({
  projectId,
  title,
  orchestrator,
  counts,
  view,
  canOperate,
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
  onNewIssue: () => void;
  /** Absent while there is no canvas to fit. */
  onFit?: () => void;
  onViewChange: (view: WorkspaceView) => void;
}) {
  return (
    <MetaBar
      // MetaBar's title column is `flex-1` (basis 0), so on a phone the row
      // never wraps and the title is squeezed instead; the actions take a row
      // of their own until glass-ui gives the column a basis.
      className="max-sm:[&>[data-meta-actions]]:basis-full"
      title={title}
      icon={Network}
      description="The orchestrator and the agents it runs on this project."
      {...(orchestrator
        ? {
            status: ORCHESTRATOR_HEADER_STATUS[orchestrator],
            statusLabel: ORCHESTRATOR_PILL_LABEL[orchestrator],
          }
        : {})}
      {...(counts ? { counters: fleetCounters(counts) } : {})}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <LiveStatusBadge />
          {canOperate ? (
            <Button variant="solid" onClick={onNewIssue}>
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
