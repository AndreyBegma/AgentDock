'use client';

import type {
  AdminRunnerDetail,
  AdminRuntimeProfile,
  OrchestratorSettingsRequest,
  OrchestratorSettingsView,
  ProjectDetail,
} from '@agentdock/shared';
import type { OrchestratorPermissionMode } from '@agentdock/shared/protocol';
import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { Field, Input, Select } from 'glass-ui/field';
import { Skeleton } from 'glass-ui/skeleton';
import { toast } from 'glass-ui/toast';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import {
  describeControlError,
  PERMISSION_MODE_LABEL,
  permissionModesFor,
} from '../../../../../lib/control/format';

/** Orchestrator defaults of the project (spec 17 D3). */
export function OrchestratorTab({
  project,
  isAdmin,
  canOperate,
}: {
  project: ProjectDetail;
  isAdmin: boolean;
  canOperate: boolean;
}) {
  const [settings, setSettings] = useState<OrchestratorSettingsView>();
  const [profiles, setProfiles] = useState<AdminRuntimeProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] =
    useState<OrchestratorPermissionMode>('auto');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const view = await api<OrchestratorSettingsView>(
        `/projects/${project.id}/orchestrator/settings`,
      );
      setSettings(view);
      setProfileId(view.profileId ?? '');
      setModel(view.model);
      setPermissionMode(view.permissionMode);
    } catch (err) {
      toast.error(describeControlError(err));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Listing the machine's profiles is an admin read; an operator keeps the
  // profile as it is and edits the model and the permission mode.
  useEffect(() => {
    if (!isAdmin) return;
    api<AdminRunnerDetail>(`/admin/runners/${project.runnerId}`)
      .then((runner) =>
        setProfiles(
          runner.profiles.filter((p) => !p.missing && p.runtime !== 'codex'),
        ),
      )
      .catch((err) => toast.error(describeControlError(err)));
  }, [isAdmin, project.runnerId]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    // Only the fields that changed: a PUT of an unchanged bypassPermissions by
    // an operator would be refused for a value they never touched.
    const body: OrchestratorSettingsRequest = {};
    if (isAdmin && (profileId || null) !== settings.profileId) {
      body.profileId = profileId || null;
    }
    if (model.trim() !== settings.model) body.model = model.trim();
    if (permissionMode !== settings.permissionMode) {
      body.permissionMode = permissionMode;
    }
    if (Object.keys(body).length === 0) return;
    setBusy(true);
    try {
      await api(`/projects/${project.id}/orchestrator/settings`, {
        method: 'PUT',
        body,
      });
      toast.success('Orchestrator settings saved.');
      await load();
    } catch (err) {
      toast.error(describeControlError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <Skeleton className="h-64 w-full" />;

  const modes = permissionModesFor(isAdmin);
  const currentLabel = settings.effectiveProfile?.label;
  const dirty =
    (isAdmin && (profileId || null) !== settings.profileId) ||
    model.trim() !== settings.model ||
    permissionMode !== settings.permissionMode;

  return (
    <Card pad="lg">
      <form className="flex flex-col gap-4" onSubmit={save}>
        <p className="text-ink-2 text-sm">
          What “Start” on the Fleet page uses unless you override it there. The
          orchestrator runs on Claude profiles only.
        </p>
        <Field
          label="Runtime profile"
          htmlFor="orch-set-profile"
          hint={
            isAdmin
              ? `Profiles of ${project.runnerName}. None uses the project’s default profile${currentLabel ? ` (now ${currentLabel})` : ''}.`
              : `Using ${currentLabel ?? 'no profile'}. Only administrators change the profile.`
          }
        >
          <Select
            id="orch-set-profile"
            value={profileId}
            disabled={!isAdmin}
            onChange={(e) => setProfileId(e.target.value)}
          >
            <option value="">Project default</option>
            {isAdmin ? (
              profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label} ({profile.runtime})
                </option>
              ))
            ) : settings.profileId ? (
              <option value={settings.profileId}>
                {currentLabel ?? 'Selected profile'}
              </option>
            ) : null}
          </Select>
        </Field>
        <Field label="Model" htmlFor="orch-set-model" required>
          <Input
            id="orch-set-model"
            value={model}
            maxLength={100}
            disabled={!canOperate}
            onChange={(e) => setModel(e.target.value)}
          />
        </Field>
        <Field
          label="Permission mode"
          htmlFor="orch-set-perm"
          hint={
            isAdmin
              ? 'bypassPermissions lets the orchestrator run without asking; it is audited.'
              : 'bypassPermissions can only be chosen by an administrator.'
          }
        >
          <Select
            id="orch-set-perm"
            value={permissionMode}
            disabled={!canOperate}
            onChange={(e) =>
              setPermissionMode(
                modes.find((m) => m === e.target.value) ?? permissionMode,
              )
            }
          >
            {!modes.some((m) => m === settings.permissionMode) ? (
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
        {canOperate ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-3 text-xs">
              {settings.updatedBy
                ? `Last changed by ${settings.updatedBy.email}`
                : 'Never changed — built-in defaults.'}
            </span>
            <Button
              variant="solid"
              type="submit"
              disabled={busy || !dirty || !model.trim()}
            >
              Save
            </Button>
          </div>
        ) : (
          <p className="text-ink-3 text-sm">
            Only operators and administrators can change these settings.
          </p>
        )}
      </form>
    </Card>
  );
}
