'use client';

import type {
  ProjectDetail,
  UiProfileRebuildResult,
  UiProfileVersionsView,
  UiProfileVersionView,
  UiProfileView,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Select } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { toast } from '@andrewbehma/glass-ui/toast';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Markdown } from '../../../../../../components/markdown/markdown';
import { AsyncSection } from '../../../../../../components/prerequisites/async-section';
import { DisabledReason } from '../../../../../../components/prerequisites/disabled-reason';
import { api } from '../../../../../../lib/api';
import {
  describeDesignError,
  PROFILE_STATUS_HINT,
  PROFILE_STATUS_LABEL,
  PROFILE_STATUS_PILL,
  rebuildRunnerGate,
} from '../../../../../../lib/design/format';
import { runHref, uiProfileApi } from '../../../../../../lib/design/href';
import { Time } from '../../../../../../lib/format/time';
import { runnerGateCopy } from '../../../../../../lib/planner/runner-support';
import { useErrorToast } from '../../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../../lib/section/use-section';
import { ProfileEditor } from './profile-editor';
import { ProfilePreview } from './profile-preview';

/** While a build runs the page asks again; a build takes minutes. */
const BUILDING_POLL_MS = 10_000;

/**
 * Settings → Design → UI profile (spec 223 D12–D14): status, versions, the
 * rendered summary, the style kit and snippets, their preview through the
 * mockup endpoint, **Edit** (project admin) and **Rebuild** (operator).
 */
export function ProfileSection({
  projectId,
  isAdmin,
  canOperate,
}: {
  projectId: string;
  isAdmin: boolean;
  canOperate: boolean;
}) {
  const profile = useSection(
    () => api<UiProfileView>(uiProfileApi(projectId)),
    [projectId],
  );
  const versions = useSection(
    () => api<UiProfileVersionsView>(`${uiProfileApi(projectId)}/versions`),
    [projectId, profile.data?.current?.version],
  );
  const [picked, setPicked] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const showError = useErrorToast();
  const router = useRouter();

  const current = profile.data?.current ?? null;
  const shownVersion = picked ?? current?.version ?? null;
  const older = useSection<UiProfileVersionView | null>(
    () =>
      picked === null || picked === current?.version
        ? Promise.resolve(null)
        : api<UiProfileVersionView>(
            `${uiProfileApi(projectId)}/versions?version=${picked}`,
          ),
    [projectId, picked, current?.version],
  );
  const shown = older.data ?? current;

  // #233: a runner that advertised its commands without `uiprofile.build`
  // turns Build off before it is tried.
  const project = useSection(
    () => api<ProjectDetail>(`/projects/${projectId}`),
    [projectId],
  );
  const gate = rebuildRunnerGate(project.data);
  const runnerCopy = gate ? runnerGateCopy('uiProfileBuild', gate) : null;

  const { retry } = profile;
  const building = profile.data?.status === 'building';
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(retry, BUILDING_POLL_MS);
    return () => clearInterval(timer);
  }, [building, retry]);

  const rebuild = async () => {
    setRebuilding(true);
    try {
      const { runId } = await api<UiProfileRebuildResult>(
        `${uiProfileApi(projectId)}/rebuild`,
        { method: 'POST' },
      );
      setConfirming(false);
      toast.success('Profile build started', {
        action: {
          label: 'Open run',
          onClick: () => router.push(runHref(projectId, runId)),
        },
      });
      retry();
    } catch (error) {
      showError(describeDesignError(error, projectId));
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <section aria-labelledby="ui-profile" className="flex flex-col gap-3">
      <AsyncSection
        section={profile}
        unavailable={{
          title: 'The UI profile could not be loaded',
          stillWorks: 'Designs keep using the profile they were drawn from.',
        }}
        empty={null}
      >
        {(data) => (
          <>
            <SectionHeader
              headingId="ui-profile"
              title="UI profile"
              description={PROFILE_STATUS_HINT[data.status]}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill
                    status={PROFILE_STATUS_PILL[data.status]}
                    label={PROFILE_STATUS_LABEL[data.status]}
                  />
                  {canOperate ? (
                    <Button
                      size="sm"
                      variant="glass"
                      disabled={
                        building || rebuilding || editing || runnerCopy !== null
                      }
                      title={building ? 'A build is running.' : undefined}
                      aria-describedby={
                        runnerCopy ? 'ui-profile-runner-reason' : undefined
                      }
                      onClick={() => setConfirming(true)}
                    >
                      {data.current ? 'Rebuild' : 'Build'}
                    </Button>
                  ) : null}
                  {isAdmin && data.current && !editing ? (
                    <Button
                      size="sm"
                      variant="glass"
                      disabled={building}
                      onClick={() => setEditing(true)}
                    >
                      Edit
                    </Button>
                  ) : null}
                </div>
              }
            />
            {canOperate && runnerCopy ? (
              <DisabledReason
                id="ui-profile-runner-reason"
                href={runnerCopy.href}
                cta={runnerCopy.cta}
              >
                {runnerCopy.reason}
              </DisabledReason>
            ) : null}
            {data.buildRunId ? (
              <Link
                href={runHref(projectId, data.buildRunId)}
                className="self-start text-sm text-accent underline-offset-2 hover:underline"
              >
                Open the running build
              </Link>
            ) : null}

            {!data.current ? (
              <EmptyState
                title="No UI profile yet"
                description="It describes the project's libraries, tokens and components, with a style kit every mockup reuses. The first design builds it, or build it now."
              />
            ) : editing ? (
              <ProfileEditor
                projectId={projectId}
                profile={data.current}
                onDone={(saved) => {
                  setEditing(false);
                  if (saved) {
                    setPicked(null);
                    retry();
                  }
                }}
              />
            ) : (
              <>
                <VersionPicker
                  versions={versions.data?.items ?? []}
                  value={shownVersion}
                  current={data.current.version}
                  onChange={setPicked}
                />
                {shown ? (
                  <ProfileBody projectId={projectId} profile={shown} />
                ) : null}
              </>
            )}
          </>
        )}
      </AsyncSection>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Rebuild the UI profile?"
        consequence="A planner run reads the project's UI on the base branch and writes a new version. It costs a run against the budget; your manual edits are kept as rules it must follow."
        verb="Rebuild"
        busy={rebuilding}
        onConfirm={() => void rebuild()}
      />
    </section>
  );
}

function VersionPicker({
  versions,
  value,
  current,
  onChange,
}: {
  versions: UiProfileVersionsView['items'];
  value: number | null;
  current: number;
  onChange: (version: number | null) => void;
}) {
  if (versions.length <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
      <span aria-hidden="true">Version</span>
      <Select
        aria-label="Profile version"
        className="h-8 w-auto text-sm"
        value={value ?? current}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(v === current ? null : v);
        }}
      >
        {versions.map((v) => (
          <option key={v.id} value={v.version}>
            {`v${v.version} · ${v.source === 'manual' ? `edited by ${v.author?.name ?? 'a former member'}` : 'built'}${v.version === current ? ' (current)' : ''}`}
          </option>
        ))}
      </Select>
    </div>
  );
}

function ProfileBody({
  projectId,
  profile,
}: {
  projectId: string;
  profile: UiProfileVersionView;
}) {
  const [showKit, setShowKit] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [showGlobs, setShowGlobs] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
        <Badge
          size="md"
          tone="neutral"
          label={profile.source === 'manual' ? 'Manual edit' : 'Built'}
        />
        {profile.hasUi ? null : (
          <Badge size="md" tone="warn" label="No user interface" />
        )}
        <span>
          v{profile.version} · <Time value={profile.createdAt} />
          {profile.author ? ` · ${profile.author.name}` : ''}
        </span>
        {profile.runId ? (
          <Link
            href={runHref(projectId, profile.runId)}
            className={buttonClassName({ variant: 'ghost', size: 'sm' })}
          >
            Build run
          </Link>
        ) : null}
      </div>

      <div className="rounded-md border border-line p-4">
        <Markdown>{profile.summary}</Markdown>
      </div>

      <ProfilePreview projectId={projectId} version={profile.version} />

      <Disclosure
        open={showKit}
        onOpenChange={setShowKit}
        trigger="Style kit (CSS)"
      >
        <CodeBlock
          code={profile.kit || '/* empty */'}
          language="css"
          maxHeight={420}
        />
      </Disclosure>
      <Disclosure
        open={showSnippets}
        onOpenChange={setShowSnippets}
        trigger={`Snippets (${profile.snippets.length})`}
      >
        <div className="flex flex-col gap-3 pt-2">
          {profile.snippets.map((s) => (
            <div key={s.name} className="flex flex-col gap-1">
              <h4 className="text-xs font-semibold text-ink-2">{s.name}</h4>
              <CodeBlock code={s.html} language="html" maxHeight={240} />
            </div>
          ))}
        </div>
      </Disclosure>
      <Disclosure
        open={showGlobs}
        onOpenChange={setShowGlobs}
        trigger={`Built from (${profile.fingerprintGlobs.length} patterns)`}
      >
        <CodeBlock code={profile.fingerprintGlobs.join('\n')} maxHeight={200} />
      </Disclosure>
      {profile.obligations ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-ink-2">
            Manual edits this build had to keep
          </h4>
          <CodeBlock
            code={profile.obligations}
            language="diff"
            maxHeight={240}
          />
        </div>
      ) : null}
    </div>
  );
}
