'use client';

import {
  type AdminRunnerDetail,
  type AdminRuntimeProfile,
  configMergeApproval,
  mergeApprovalMismatch,
  type ProjectDetail,
  type UpdateProjectRequest,
} from '@agentdock/shared';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Input, Select } from 'glass-ui/field';
import { toast } from 'glass-ui/toast';
import { Toggle } from 'glass-ui/toggle';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import { mismatchSentence } from '../../../../../lib/approvals/format';
import {
  BASE_SOURCE_LABEL,
  describeProjectError,
} from '../../../../../lib/projects/format';
import { formatLastSeen } from '../../../../../lib/runners/format';

const orNull = (value: string): string | null => value.trim() || null;

export function GeneralTab({
  project,
  isAdmin,
  onChanged,
}: {
  project: ProjectDetail;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const router = useRouter();
  // D1: judged on what is saved, not on the unsaved toggle.
  const mergeApprovalNote = mismatchSentence(
    {
      agentdock: project.mergeApproval,
      config: configMergeApproval(project.codeSentinelConfig),
    },
    mergeApprovalMismatch(project),
  );
  const [displayName, setDisplayName] = useState(project.displayName);
  const [baseOverride, setBaseOverride] = useState(project.baseOverride ?? '');
  const [readyLabel, setReadyLabel] = useState(
    project.readyLabelOverride ?? '',
  );
  const [mergeApproval, setMergeApproval] = useState(project.mergeApproval);
  const [profileId, setProfileId] = useState(project.defaultProfileId ?? '');
  const [profiles, setProfiles] = useState<AdminRuntimeProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset the form when the project reloads (a save, a live frame).
  useEffect(() => {
    setDisplayName(project.displayName);
    setBaseOverride(project.baseOverride ?? '');
    setReadyLabel(project.readyLabelOverride ?? '');
    setMergeApproval(project.mergeApproval);
    setProfileId(project.defaultProfileId ?? '');
  }, [project]);

  useEffect(() => {
    if (!isAdmin) return;
    api<AdminRunnerDetail>(`/admin/runners/${project.runnerId}`)
      .then((runner) => setProfiles(runner.profiles.filter((p) => !p.missing)))
      .catch((err) => toast.error(describeProjectError(err)));
  }, [isAdmin, project.runnerId]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const name = displayName.trim();
    if (!name) return;
    const body: UpdateProjectRequest = {
      displayName: name,
      baseOverride: orNull(baseOverride),
      readyLabelOverride: orNull(readyLabel),
      defaultProfileId: profileId || null,
      mergeApproval,
    };
    setBusy(true);
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', body });
      toast.success('Settings saved.');
      onChanged();
    } catch (err) {
      toast.error(describeProjectError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api(`/admin/projects/${project.id}`, { method: 'DELETE' });
      toast.success(`${project.displayName} removed. Nothing on disk changed.`);
      router.push('/projects');
    } catch (err) {
      toast.error(describeProjectError(err));
      setBusy(false);
      setDeleting(false);
    }
  };

  const currentProfile = profiles.find(
    (p) => p.id === project.defaultProfileId,
  );

  return (
    <Card pad="lg" className="flex flex-col gap-6">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-2">Root</dt>
        <dd className="font-mono break-all">{project.rootPath}</dd>
        <dt className="text-ink-2">Detected base</dt>
        <dd>
          {project.baseBranch}
          <span className="text-ink-3">
            {' '}
            · {BASE_SOURCE_LABEL[project.baseSource]}
          </span>
        </dd>
        <dt className="text-ink-2">Last inspected</dt>
        <dd>{formatLastSeen(project.lastInspectedAt)}</dd>
      </dl>

      <form className="flex flex-col gap-4" onSubmit={save}>
        <Field label="Display name" htmlFor="project-name" required>
          <Input
            id="project-name"
            value={displayName}
            maxLength={100}
            disabled={!isAdmin}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field
          label="Base branch override"
          htmlFor="project-base"
          hint={`Empty uses the detected ${project.baseBranch}.`}
        >
          <Input
            id="project-base"
            value={baseOverride}
            maxLength={255}
            disabled={!isAdmin}
            onChange={(e) => setBaseOverride(e.target.value)}
          />
        </Field>
        <Field
          label="Ready label override"
          htmlFor="project-ready"
          hint="Empty uses the label from the Code Sentinel config."
        >
          <Input
            id="project-ready"
            value={readyLabel}
            maxLength={100}
            disabled={!isAdmin}
            onChange={(e) => setReadyLabel(e.target.value)}
          />
        </Field>
        <Field
          label="Default runtime profile"
          htmlFor="project-profile"
          hint={`Profiles of ${project.runnerName}.`}
        >
          <Select
            id="project-profile"
            value={profileId}
            disabled={!isAdmin}
            onChange={(e) => setProfileId(e.target.value)}
          >
            <option value="">None</option>
            {isAdmin ? (
              profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label} ({profile.runtime})
                </option>
              ))
            ) : project.defaultProfileId ? (
              <option value={project.defaultProfileId}>
                {currentProfile?.label ?? 'Selected profile'}
              </option>
            ) : null}
          </Select>
        </Field>
        <div className="flex items-center justify-between gap-4">
          <div>
            <span id="project-merge-label" className="text-sm font-medium">
              Merge approval
            </span>
            <p className="text-ink-3 text-xs">
              Your intent: a person approves every pull request before the
              orchestrator merges it. The orchestrator itself obeys the
              project’s config.
            </p>
          </div>
          {isAdmin ? (
            <Toggle
              checked={mergeApproval}
              onChange={setMergeApproval}
              labelledBy="project-merge-label"
            />
          ) : (
            <span className="text-sm">{mergeApproval ? 'on' : 'off'}</span>
          )}
        </div>
        {mergeApprovalNote ? (
          <Banner tone="warn" title="Merge approval settings disagree">
            {mergeApprovalNote}
          </Banner>
        ) : null}

        {isAdmin ? (
          <div className="flex justify-between gap-2">
            <Button
              variant="ghost"
              type="button"
              onClick={() => setDeleting(true)}
            >
              Remove project
            </Button>
            <Button
              variant="solid"
              type="submit"
              disabled={busy || !displayName.trim()}
            >
              Save
            </Button>
          </div>
        ) : (
          <p className="text-ink-3 text-sm">
            Only administrators can change these settings.
          </p>
        )}
      </form>

      <DialogRoot open={deleting} onOpenChange={setDeleting}>
        <DialogContent
          title={`Remove ${project.displayName}?`}
          description="The project, its members and its docs source are removed and the runner stops watching it. Files on disk are not touched."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(false)}>
                Cancel
              </Button>
              <Button variant="solid" onClick={remove} disabled={busy}>
                Remove
              </Button>
            </>
          }
        >
          <p className="font-mono text-sm break-all">{project.rootPath}</p>
        </DialogContent>
      </DialogRoot>
    </Card>
  );
}
