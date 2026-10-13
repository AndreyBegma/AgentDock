'use client';

import type {
  OrchestratorSettingsView,
  OrchestratorStartRequest,
  OrchestratorStatusView,
} from '@agentdock/shared';
import type {
  OrchestratorMode,
  OrchestratorPermissionMode,
} from '@agentdock/shared/protocol';
import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import { useState } from 'react';
import { DisabledReason } from '../../../../../components/prerequisites/disabled-reason';
import { api } from '../../../../../lib/api';
import {
  COMMAND_PENDING_LABEL,
  describeControlErrorHint,
  MODE_LABEL,
  PERMISSION_MODE_LABEL,
  permissionModesFor,
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

/** Start, Stop and status refresh of the orchestrator (spec 17 D2–D5). */
export function OrchestratorControls({
  projectId,
  control,
  canOperate,
  isAdmin,
  settings,
  reasons,
  startOpen: starting,
  onStartOpenChange: setStarting,
}: {
  projectId: string;
  control: Control;
  canOperate: boolean;
  isAdmin: boolean;
  /** Loaded by the page; undefined while loading or when it failed. */
  settings: OrchestratorSettingsView | undefined;
  /** Why Start and Stop are off, when the reason will not clear by itself. */
  reasons: ControlReasons;
  startOpen: boolean;
  onStartOpenChange: (open: boolean) => void;
}) {
  const [status, setStatus] = useState<OrchestratorStatusView>();
  const [refreshing, setRefreshing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const showError = useErrorToast();

  const [mode, setMode] = useState<OrchestratorMode>('start');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] =
    useState<OrchestratorPermissionMode>('auto');

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

  const openStart = () => {
    setMode('start');
    setModel(settings?.model ?? '');
    setPermissionMode(settings?.permissionMode ?? 'auto');
    setStarting(true);
  };

  const start = async () => {
    // Only what differs from the project's settings is an override.
    const request: OrchestratorStartRequest = { mode };
    const trimmed = model.trim();
    if (trimmed && trimmed !== settings?.model) request.model = trimmed;
    if (permissionMode !== settings?.permissionMode) {
      request.permissionMode = permissionMode;
    }
    setStarting(false);
    const run = await control.start(request);
    if (run) void refresh();
  };

  const stop = async () => {
    setStopping(false);
    const run = await control.stop();
    if (run) void refresh();
  };

  const startBusy = control.busy('orchestrator.start');
  const stopBusy = control.busy('orchestrator.stop');
  const modes = permissionModesFor(isAdmin);
  const { lines: reasonLines, ids: reasonIds } = reasonLinesFor(reasons);

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
            <Button
              variant="solid"
              disabled={startBusy || !settings || reasons.start !== null}
              aria-describedby={reasonIds.start}
              onClick={openStart}
            >
              Start…
            </Button>
            <Button
              variant="glass"
              disabled={stopBusy || reasons.stop !== null}
              aria-describedby={reasonIds.stop}
              onClick={() => setStopping(true)}
            >
              Stop
            </Button>
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
        <Button variant="ghost" disabled={refreshing} onClick={refresh}>
          {refreshing ? 'Checking…' : 'Refresh status'}
        </Button>
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

      <DialogRoot open={starting} onOpenChange={setStarting}>
        <DialogContent
          title="Start the orchestrator"
          description="Launches /code-sentinel:orchestrator in a tmux session on the project’s machine, in the project root."
          footer={
            <>
              <Button variant="ghost" onClick={() => setStarting(false)}>
                Cancel
              </Button>
              <Button variant="solid" onClick={start}>
                Start
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <Field label="Command" htmlFor="orch-mode">
              <Select
                id="orch-mode"
                value={mode}
                onChange={(e) =>
                  setMode(e.target.value === 'next' ? 'next' : 'start')
                }
              >
                {(['start', 'next'] as const).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Profile"
              htmlFor="orch-profile"
              hint="Change it in the project’s Orchestrator settings."
            >
              <Input
                id="orch-profile"
                readOnly
                value={settings?.effectiveProfile?.label ?? '(none set)'}
              />
            </Field>
            <Field label="Model" htmlFor="orch-model">
              <Input
                id="orch-model"
                value={model}
                maxLength={100}
                onChange={(e) => setModel(e.target.value)}
              />
            </Field>
            <Field label="Permission mode" htmlFor="orch-perm">
              <Select
                id="orch-perm"
                value={permissionMode}
                onChange={(e) =>
                  setPermissionMode(
                    modes.find((m) => m === e.target.value) ?? 'auto',
                  )
                }
              >
                {settings &&
                !modes.some((m) => m === settings.permissionMode) ? (
                  <option value={settings.permissionMode}>
                    {PERMISSION_MODE_LABEL[settings.permissionMode]}
                  </option>
                ) : null}
                {modes.map((m) => (
                  <option key={m} value={m}>
                    {PERMISSION_MODE_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </DialogContent>
      </DialogRoot>

      <DialogRoot open={stopping} onOpenChange={setStopping}>
        <DialogContent
          title="Stop the orchestrator?"
          description="Only the orchestrator’s own session is killed. Workers keep running, and no worktree, branch or slot is touched. Start it again later to pick the board up."
          footer={
            <>
              <Button variant="ghost" onClick={() => setStopping(false)}>
                Cancel
              </Button>
              <Button variant="solid" onClick={stop}>
                Stop the orchestrator
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-2">
            The session is stopped immediately; any prompt it is in the middle
            of is lost.
          </p>
        </DialogContent>
      </DialogRoot>
    </div>
  );
}
