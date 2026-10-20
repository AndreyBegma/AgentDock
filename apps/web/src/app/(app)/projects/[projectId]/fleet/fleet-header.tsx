'use client';

import type { OrchestratorStatus } from '@agentdock/shared';
import { MetaBar } from '@andrewbehma/glass-ui/meta-bar';
import type { PageHeaderOverflowItem } from '@andrewbehma/glass-ui/page-header';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Maximize, Settings } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
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
  list: 'Slots',
  canvas: 'Agent tree',
};

/**
 * The Fleet's header (#160, #213, C-283): the shared `PageHeader`, the
 * orchestrator's state beside the title in the one vocabulary the card and
 * the canvas use, the fleet's counters in `meta`, New issue as the one solid
 * action and everything else — fit, settings — behind the `…` menu. The view
 * switch is the one quiet control beside it.
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
  const router = useRouter();
  const live = useLivePaused();
  // The top bar's dot says "live"; the page speaks up only when it is not.
  const notLive = live.status !== 'connected' || live.paused;
  const overflow: PageHeaderOverflowItem[] = [
    ...(onFit
      ? [{ id: 'fit', label: 'Fit to view', icon: Maximize, onSelect: onFit }]
      : []),
    {
      id: 'settings',
      label: 'Orchestrator settings',
      icon: Settings,
      onSelect: () => router.push(orchestratorSettingsHref(projectId)),
    },
  ];
  return (
    <PageHeader
      className="mb-0"
      title={title}
      description="The orchestrator and the agents it runs on this project."
      link={NextLink}
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
          <SegmentedControl size="sm" role="group" aria-label="View">
            {(['list', 'canvas'] as const).map((v) => (
              <SegmentedControlItem
                key={v}
                active={v === view}
                layoutId="fleet-view"
              >
                <button
                  type="button"
                  aria-pressed={v === view}
                  className="w-full px-3 text-sm whitespace-nowrap"
                  onClick={() => onViewChange(v)}
                >
                  {VIEW_LABEL[v]}
                </button>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      }
      {...(canOperate && newIssuePrimary
        ? {
            // The capsule's `+` carries New issue below the tablet edge.
            primaryAction: { label: 'New issue', onClick: onNewIssue },
            primaryActionOnPhone: 'hidden' as const,
          }
        : {})}
      overflow={
        canOperate && !newIssuePrimary
          ? [
              { id: 'new-issue', label: 'New issue', onSelect: onNewIssue },
              ...overflow,
            ]
          : overflow
      }
    />
  );
}
