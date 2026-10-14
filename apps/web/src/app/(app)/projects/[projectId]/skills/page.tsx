'use client';

import type {
  InstalledSkillsView,
  InstalledSkillView,
  ProjectRuntimeProfile,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { Play } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { RunnerOfflineBanner } from '../../../../../components/prerequisites/prerequisite-banner';
import { ScrollX } from '../../../../../components/scroll-x/scroll-x';
import { api } from '../../../../../lib/api';
import { Time } from '../../../../../lib/format/time';
import { useSection } from '../../../../../lib/section/use-section';
import {
  commandUnavailableText,
  dedupeSkills,
  describeSkillsError,
  groupBySkillScope,
  isCommandUnavailable,
  isNotFound,
  profilesLabel,
  provenanceLabel,
  SCOPE_LABEL,
  type SkillRow,
  skillRunProfiles,
  skillRunsHref,
  skillToRun,
} from '../../../../../lib/skills/format';
import { useProjectDetail } from '../use-project-detail';
import { RunDialog } from './run-dialog';

/** One scope's skills: a `DataTable` that scrolls inside its own frame (#213). */
function SkillRows({
  items,
  canOperate,
  onRun,
}: {
  items: InstalledSkillView[];
  canOperate: boolean;
  onRun: (skill: InstalledSkillView) => void;
}) {
  const rows = dedupeSkills(items);
  const columns: Column<SkillRow>[] = [
    {
      id: 'skill',
      header: 'Skill',
      cell: ({ skill: item, profiles }) => (
        <span className="flex flex-col">
          <span className="font-mono text-sm">{item.invocation}</span>
          {profiles.length > 0 ? (
            <span className="text-xs text-ink-3">
              <Tooltip content={profiles.join(', ')}>
                <button type="button" className="cursor-help">
                  {profilesLabel(profiles)}
                </button>
              </Tooltip>
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'runtime',
      header: 'Runtime',
      cell: ({ skill: item }) => <Badge tone="neutral" label={item.runtime} />,
    },
    {
      id: 'source',
      header: 'Source',
      cell: ({ skill: item }) => provenanceLabel(item),
    },
    {
      id: 'description',
      header: 'Description',
      cell: ({ skill: item }) => (
        <span
          className="block max-w-56 truncate text-sm text-ink-2 sm:max-w-md"
          title={item.description ?? undefined}
        >
          {item.description ?? '—'}
        </span>
      ),
    },
    ...(canOperate
      ? [
          {
            id: 'run',
            header: <span className="sr-only">Run</span>,
            align: 'end' as const,
            cell: ({ skill: item }: SkillRow) =>
              item.runnable && item.runtime === 'claude' ? (
                <Tooltip content={`Run ${item.invocation}`}>
                  <Button
                    size="sm"
                    icon
                    variant="ghost"
                    aria-label={`Run ${item.invocation}`}
                    onClick={() => onRun(item)}
                  >
                    <Play aria-hidden="true" className="size-4" />
                  </Button>
                </Tooltip>
              ) : (
                <span className="text-xs text-ink-3">
                  {item.runnable ? 'Claude only' : 'Not runnable'}
                </span>
              ),
          },
        ]
      : []),
  ];
  return (
    <ScrollX label="Skills" edgeClassName="from-surface">
      <DataTable
        rows={rows}
        getRowId={(row) => row.skill.id}
        columns={columns}
        stickyHeader={false}
      />
    </ScrollX>
  );
}

export default function ProjectSkillsPage() {
  // `useSearchParams` needs a boundary for the static shell.
  return (
    <Suspense fallback={null}>
      <SkillsView />
    </Suspense>
  );
}

function SkillsView() {
  const { projectId } = useParams<{ projectId: string }>();
  const runParam = useSearchParams().get('run');
  const detail = useProjectDetail(projectId);
  const project = detail.data;
  const skills = useSection(
    () => api<InstalledSkillsView>(`/projects/${projectId}/skills`),
    [projectId],
  );
  const [scanned, setScanned] = useState<InstalledSkillsView>();
  const [unavailable, setUnavailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState<InstalledSkillView | null>(null);

  // The runner's profiles, for whoever can run a skill (operator and up).
  const isAdmin = project?.role === 'admin';
  const canRun = project !== undefined && project.role !== 'viewer';
  const profiles = useSection<ProjectRuntimeProfile[]>(
    () =>
      canRun
        ? api<ProjectRuntimeProfile[]>(
            `/projects/${projectId}/runtime-profiles`,
          ).then(skillRunProfiles)
        : Promise.resolve([]),
    [canRun, projectId],
  );

  const refresh = async () => {
    setRefreshing(true);
    setUnavailable(false);
    try {
      setScanned(
        await api<InstalledSkillsView>(
          `/projects/${projectId}/skills/refresh`,
          {
            method: 'POST',
          },
        ),
      );
      toast.success('Skills rescanned.');
    } catch (err) {
      if (isCommandUnavailable(err)) setUnavailable(true);
      else toast.error(describeSkillsError(err, project?.runnerName));
    } finally {
      setRefreshing(false);
    }
  };

  // A rescan's answer is newer than the load before it.
  const view = scanned ?? skills.data;
  const groups = useMemo(() => groupBySkillScope(view?.items ?? []), [view]);

  // History's Retry links here with `?run=<invocation>`: open its dialog once.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened || !canRun || !skills.data) return;
    setOpened(true);
    const target = skillToRun(skills.data.items, runParam);
    if (target) setRunning(target);
  }, [opened, canRun, skills.data, runParam]);

  if (skills.data === undefined && isNotFound(skills.error)) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
        action={
          <Link href="/projects" className="text-sm text-accent-ink underline">
            Open Projects
          </Link>
        }
      />
    );
  }

  const canOperate = canRun;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <PageHeader
          className="mb-0"
          title="Skills"
          description={
            <>
              Skills installed in this project, in the runner’s runtime profiles
              and in its plugins.{' '}
              {view ? (
                view.scannedAt ? (
                  <>
                    Scanned <Time value={view.scannedAt} />.
                  </>
                ) : (
                  'Not scanned yet.'
                )
              ) : null}{' '}
              <Link
                href={skillRunsHref(projectId)}
                className="text-accent-ink underline underline-offset-2"
              >
                Recent runs
              </Link>
            </>
          }
          actions={
            canOperate ? (
              <>
                <Button variant="glass" disabled={refreshing} onClick={refresh}>
                  {refreshing ? 'Scanning…' : 'Rescan'}
                </Button>
                <Link
                  href="/skills"
                  className={buttonClassName({ variant: 'solid' })}
                >
                  Find skills
                </Link>
              </>
            ) : undefined
          }
        />
        {project ? <RunnerOfflineBanner project={project} /> : null}
      </div>

      {unavailable ? (
        <Banner tone="warn" title="This runner is too old to scan skills">
          {commandUnavailableText(project?.runnerName)} The list below is the
          last scan.
        </Banner>
      ) : null}

      <AsyncSection
        section={{ ...skills, data: view }}
        unavailable={{
          title: 'Skills could not be loaded',
          stillWorks: 'Fleet, queue and history are still available.',
        }}
        isEmpty={() => groups.length === 0}
        empty={
          <EmptyState
            title="No skills found"
            description={
              view?.scannedAt
                ? 'The last scan found no skill for this project. Add one to the repository’s skills folder, or find one to install, then rescan.'
                : 'Nothing has been scanned yet. A rescan asks the runner to look.'
            }
            action={
              canOperate ? (
                <Button variant="glass" disabled={refreshing} onClick={refresh}>
                  {refreshing ? 'Scanning…' : 'Rescan'}
                </Button>
              ) : undefined
            }
          />
        }
      >
        {() =>
          groups.map((group) => (
            <section key={group.scope} aria-labelledby={`scope-${group.scope}`}>
              <SectionHeader
                headingId={`scope-${group.scope}`}
                className="mb-2"
                title={
                  <>
                    {SCOPE_LABEL[group.scope]}{' '}
                    <span className="font-normal text-ink-3">
                      ({dedupeSkills(group.items).length})
                    </span>
                  </>
                }
              />
              <SkillRows
                items={group.items}
                canOperate={canOperate}
                onRun={setRunning}
              />
            </section>
          ))
        }
      </AsyncSection>

      <RunDialog
        projectId={projectId}
        runnerName={project?.runnerName}
        skill={running}
        profiles={profiles.data ?? []}
        profilesFailed={profiles.data === undefined && profiles.error !== null}
        isAdmin={isAdmin}
        onOpenChange={(open) => {
          if (!open) setRunning(null);
        }}
      />
    </div>
  );
}
