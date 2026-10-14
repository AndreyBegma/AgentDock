'use client';

import type {
  OrchestratorSettingsView,
  OrchestratorStatusView,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { DisabledReason } from '../../../../../components/prerequisites/disabled-reason';
import { api } from '../../../../../lib/api';
import {
  COMMAND_PENDING_LABEL,
  describeControlErrorHint,
  PERMISSION_MODE_LABEL,
} from '../../../../../lib/control/format';
import type { ControlReason } from '../../../../../lib/control/reasons';
import type { useControl } from '../../../../../lib/control/use-control';
import { formatAge } from '../../../../../lib/fleet/format';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import { PendingLabel } from './pending-label';
import type { ControlReasons } from './use-control-reasons';

type Control = ReturnType<typeof useControl>;

/**
 * The reason lines under Start and Stop. One shared reason (the runner is
 * offline) is said once; different ones are each named after their button.
 */
function reasonLinesFor({ start, stop }: ControlReasons) {
  const lines: { id: string; prefix: string; reason: ControlReason }[] = [];
  const ids: { start?: string; stop?: string } = {};
  if (start && stop && start.text === stop.text) {
    lines.push({ id: 'orch-reason', prefix: '', reason: start });
    ids.start = ids.stop = 'orch-reason';
    return { lines, ids };
  }
  if (start) {
    lines.push({ id: 'orch-start-reason', prefix: 'Start: ', reason: start });
    ids.start = 'orch-start-reason';
  }
  if (stop) {
    lines.push({ id: 'orch-stop-reason', prefix: 'Stop: ', reason: stop });
    ids.stop = 'orch-stop-reason';
  }
  return { lines, ids };
}

/**
 * Start, Stop and status refresh of the orchestrator (spec 17 D2–D5). Start
 * opens the page's one Start dialog; Stop asks first, with `ConfirmDialog`.
 */
export function OrchestratorControls({
  projectId,
  control,
  canOperate,
  isAdmin,
  settings,
  reasons,
  showStop,
  showStart,
  onStart,
}: {
  projectId: string;
  control: Control;
  canOperate: boolean;
  isAdmin: boolean;
  /** Loaded by the page; undefined while loading or when it failed. */
  settings: OrchestratorSettingsView | undefined;
  /** Why Start and Stop are off, when the reason will not clear by itself. */
  reasons: ControlReasons;
  /** False while the orchestrator is known to be absent: nothing to stop. */
  showStop: boolean;
  /**
   * False on an empty fleet, where the first-project checklist holds the one
   * Start (#213).
   */
  showStart: boolean;
  onStart: () => void;
}) {
  const [status, setStatus] = useState<OrchestratorStatusView>();
  const [refreshing, setRefreshing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const showError = useErrorToast();

  const refresh = async () => {
    setRefreshing(true);
    try {
      setStatus(
        await api<OrchestratorStatusView>(
          `/projects/${projectId}/orchestrator/status`,
        ),
      );
    } catch (err) {
      showError(describeControlErrorHint(err, { projectId, isAdmin }));
    } finally {
      setRefreshing(false);
    }
  };

  const startBusy = control.busy('orchestrator.start');
  const stopBusy = control.busy('orchestrator.stop');

  const stop = async () => {
    const run = await control.stop();
    setStopping(false);
    if (run) void refresh();
  };

  const { lines: reasonLines, ids: reasonIds } = reasonLinesFor({
    start: showStart ? reasons.start : null,
    stop: showStop ? reasons.stop : null,
    message: reasons.message,
  });

  return (
    <div className="flex flex-col gap-3">
      {settings ? (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium text-ink-2">Profile</dt>
            <dd className="text-sm">
              {settings.effectiveProfile
                ? `${settings.effectiveProfile.label} (${settings.effectiveProfile.runtime})`
                : '(none set)'}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium text-ink-2">Model</dt>
            <dd className="text-sm">{settings.model}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium text-ink-2">Permission mode</dt>
            <dd className="text-sm">
              {PERMISSION_MODE_LABEL[settings.permissionMode]}
            </dd>
          </div>
        </dl>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {canOperate ? (
          <>
            {showStart ? (
              // Glass: the page's one solid is New issue in its header (#213).
              <Button
                variant="glass"
                disabled={startBusy || !settings || reasons.start !== null}
                aria-describedby={reasonIds.start}
                onClick={onStart}
              >
                Start…
              </Button>
            ) : null}
            {showStop ? (
              <Button
                variant="glass"
                disabled={stopBusy || reasons.stop !== null}
                aria-describedby={reasonIds.stop}
                onClick={() => setStopping(true)}
              >
                Stop
              </Button>
            ) : null}
            {startBusy ? (
              <PendingLabel
                label={COMMAND_PENDING_LABEL['orchestrator.start']}
              />
            ) : null}
            {stopBusy ? (
              <PendingLabel
                label={COMMAND_PENDING_LABEL['orchestrator.stop']}
              />
            ) : null}
          </>
        ) : null}
        <Tooltip content={refreshing ? 'Checking…' : 'Refresh status'}>
          <Button
            variant="ghost"
            icon
            aria-label="Refresh status"
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshCw
              aria-hidden="true"
              className={`size-4 ${refreshing ? 'animate-spin' : ''}`}
            />
          </Button>
        </Tooltip>
        {status ? (
          <span className="text-sm text-ink-2" role="status">
            {status.present
              ? `${status.state} · ${status.session ?? 'session unknown'}${
                  status.startedAt ? ` · up ${formatAge(status.startedAt)}` : ''
                }`
              : 'not running'}
          </span>
        ) : null}
      </div>

      {canOperate
        ? reasonLines.map(({ id, prefix, reason }) => (
            <DisabledReason
              key={id}
              id={id}
              href={reason.href}
              cta={reason.cta}
            >
              {prefix}
              {reason.text}
            </DisabledReason>
          ))
        : null}

      <ConfirmDialog
        open={stopping}
        onOpenChange={setStopping}
        title="Stop the orchestrator?"
        consequence="Only the orchestrator’s own session is killed, and any prompt it is in the middle of is lost. Workers keep running, and no worktree, branch or slot is touched. Start it again later to pick the board up."
        verb="Stop"
        busy={stopBusy}
        onConfirm={stop}
      />
    </div>
  );
}
