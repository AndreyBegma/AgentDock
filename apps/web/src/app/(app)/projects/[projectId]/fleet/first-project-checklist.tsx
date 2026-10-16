'use client';

import type {
  AdminRunnerDetail,
  AdminRuntimeProfile,
  OrchestratorSettingsView,
  UpdateProjectRequest,
} from '@agentdock/shared';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Field, Select } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Check, Circle } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { DisabledReason } from '../../../../../components/prerequisites/disabled-reason';
import { api } from '../../../../../lib/api';
import { boardNewWorkHref } from '../../../../../lib/board/href';
import {
  type ControlReason,
  orchestratorSettingsHref,
} from '../../../../../lib/control/reasons';
import { describeProjectError } from '../../../../../lib/projects/format';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import type { Section } from '../../../../../lib/section/use-section';

const FIRST_BRIEF = 'Plan the first wave of work for this project.';

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 shrink-0">
        {done ? (
          <Check aria-hidden="true" className="size-4 text-ok" />
        ) : (
          <Circle aria-hidden="true" className="size-4 text-ink-3" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm font-medium">
          <span className="sr-only">{done ? 'Done: ' : `Step ${n}: `}</span>
          {title}
        </p>
        {done ? null : children}
      </div>
    </li>
  );
}

/**
 * Step 1 inline: an admin picks the project's default runtime profile from its
 * runner's profiles, without leaving the Fleet. Everyone else is told who can.
 */
function ProfileStep({
  projectId,
  runnerId,
  isAdmin,
  onSaved,
}: {
  projectId: string;
  runnerId: string | undefined;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [profiles, setProfiles] = useState<AdminRuntimeProfile[]>();
  const [profileId, setProfileId] = useState('');
  const [saving, setSaving] = useState(false);
  const showError = useErrorToast();

  useEffect(() => {
    if (!isAdmin || !runnerId) return;
    let current = true;
    api<AdminRunnerDetail>(`/admin/runners/${runnerId}`)
      .then((runner) => {
        if (!current) return;
        const usable = runner.profiles.filter((p) => !p.missing);
        setProfiles(usable);
        // The only profile is the obvious choice.
        if (usable.length === 1) setProfileId(usable[0]?.id ?? '');
      })
      .catch((err) => {
        if (current) {
          setProfiles([]);
          showError(describeProjectError(err));
        }
      });
    return () => {
      current = false;
    };
  }, [isAdmin, runnerId, showError]);

  if (!isAdmin) {
    return (
      <p className="text-sm text-ink-2">
        An admin sets it in the project’s{' '}
        <Link
          href={orchestratorSettingsHref(projectId)}
          className="text-accent-ink underline"
        >
          Orchestrator settings
        </Link>
        .
      </p>
    );
  }

  const save = async () => {
    if (!profileId) return;
    const body: UpdateProjectRequest = { defaultProfileId: profileId };
    setSaving(true);
    try {
      await api(`/projects/${projectId}`, { method: 'PATCH', body });
      toast.success('Default profile set.');
      onSaved();
    } catch (err) {
      showError(describeProjectError(err));
    } finally {
      setSaving(false);
    }
  };

  if (profiles !== undefined && profiles.length === 0) {
    return (
      <DisabledReason
        href={`/admin/runners/${runnerId ?? ''}`}
        cta="Open the runner"
      >
        The project’s runner reports no runtime profile yet.
      </DisabledReason>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Default runtime profile" htmlFor="first-profile">
        <Select
          id="first-profile"
          value={profileId}
          disabled={profiles === undefined || saving}
          onChange={(e) => setProfileId(e.target.value)}
        >
          <option value="">
            {profiles === undefined ? 'Loading…' : 'Choose a profile'}
          </option>
          {(profiles ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.runtime})
            </option>
          ))}
        </Select>
      </Field>
      <Button variant="glass" disabled={!profileId || saving} onClick={save}>
        Set as default
      </Button>
    </div>
  );
}

/**
 * The empty Fleet (#213): one card that says what is left before agents run
 * here — a runtime profile, the orchestrator, a first brief — and holds the
 * screen's one solid button, Start.
 */
export function FirstProjectChecklist({
  projectId,
  runnerId,
  isAdmin,
  canOperate,
  settings,
  startReason,
  starting,
  onStart,
}: {
  projectId: string;
  runnerId: string | undefined;
  isAdmin: boolean;
  canOperate: boolean;
  settings: Section<OrchestratorSettingsView>;
  /** Why Start is off now; null when it can be pressed. */
  startReason: ControlReason | null;
  /** The start command is in flight. */
  starting: boolean;
  onStart: () => void;
}) {
  const profileSet =
    settings.data !== undefined && settings.data.effectiveProfile !== null;
  return (
    <Card pad="md" className="flex flex-col gap-4">
      <SectionHeader
        title="Get this project running"
        description="AgentDock does not create agents itself: the orchestrator reads the queue and dispatches a slot per issue."
      />
      <ol className="flex flex-col gap-4">
        <Step n={1} title="Set a default runtime profile" done={profileSet}>
          {settings.data === undefined ? null : (
            <ProfileStep
              projectId={projectId}
              runnerId={runnerId}
              isAdmin={isAdmin}
              onSaved={settings.retry}
            />
          )}
        </Step>
        <Step n={2} title="Start the orchestrator" done={false}>
          {canOperate ? (
            <div className="flex flex-col items-start gap-2">
              <Button
                variant="solid"
                disabled={starting || startReason !== null}
                aria-describedby={
                  startReason ? 'first-start-reason' : undefined
                }
                onClick={onStart}
              >
                Start the orchestrator
              </Button>
              {startReason ? (
                <DisabledReason
                  id="first-start-reason"
                  href={startReason.href}
                  cta={startReason.cta}
                >
                  {startReason.text}
                </DisabledReason>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-ink-2">
              Operators and admins can start it.
            </p>
          )}
        </Step>
        <Step n={3} title="Plan a first brief" done={false}>
          <p className="text-sm text-ink-2">
            New work on the Board turns an intention into cards — or issues the
            orchestrator can dispatch.
          </p>
          <div>
            <Link
              href={boardNewWorkHref(projectId, FIRST_BRIEF)}
              className={buttonClassName({ variant: 'glass', size: 'sm' })}
            >
              Start a plan
            </Link>
          </div>
        </Step>
      </ol>
    </Card>
  );
}
