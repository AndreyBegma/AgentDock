'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import type {
  OrchestratorSettingsView,
  OrchestratorStartRequest,
} from '@nautelle/shared';
import type {
  OrchestratorMode,
  OrchestratorPermissionMode,
} from '@nautelle/shared/protocol';
import { useEffect, useState } from 'react';
import {
  MODE_LABEL,
  PERMISSION_MODE_LABEL,
  permissionModesFor,
} from '../../../../../lib/control/format';
import type { useControl } from '../../../../../lib/control/use-control';

/**
 * Start the orchestrator (spec 17 D2): the command, the profile it runs with
 * and the overrides. One per page — the card's Start and the empty fleet's
 * checklist both open it — so there is one form, not two that drift.
 */
export function StartOrchestratorDialog({
  control,
  isAdmin,
  settings,
  open,
  onOpenChange,
  onStarted,
}: {
  control: ReturnType<typeof useControl>;
  isAdmin: boolean;
  /** Loaded by the page; undefined while loading or when it failed. */
  settings: OrchestratorSettingsView | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the runner accepted the start. */
  onStarted?: () => void;
}) {
  const [mode, setMode] = useState<OrchestratorMode>('start');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] =
    useState<OrchestratorPermissionMode>('auto');
  const modes = permissionModesFor(isAdmin);

  // Each opening starts from the project's settings, not the last attempt.
  useEffect(() => {
    if (!open) return;
    setMode('start');
    setModel(settings?.model ?? '');
    setPermissionMode(settings?.permissionMode ?? 'auto');
  }, [open, settings]);

  const start = async () => {
    // Only what differs from the project's settings is an override.
    const request: OrchestratorStartRequest = { mode };
    const trimmed = model.trim();
    if (trimmed && trimmed !== settings?.model) request.model = trimmed;
    if (permissionMode !== settings?.permissionMode) {
      request.permissionMode = permissionMode;
    }
    onOpenChange(false);
    const run = await control.start(request);
    if (run) onStarted?.();
  };

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Start the orchestrator"
        description="Launches /code-sentinel:orchestrator in a tmux session on the project’s machine, in the project root."
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
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
              {settings && !modes.some((m) => m === settings.permissionMode) ? (
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
  );
}
