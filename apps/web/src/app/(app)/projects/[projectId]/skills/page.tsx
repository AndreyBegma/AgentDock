'use client';

import type {
  InstalledSkillsView,
  InstalledSkillView,
  ProjectRuntimeProfile,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import type { Column } from '@andrewbehma/glass-ui/data-table';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Section } from '@andrewbehma/glass-ui/section';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { Play, RefreshCw, Search } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { RunnerOfflineBanner } from '../../../../../components/prerequisites/prerequisite-banner';
import { ResponsiveRows } from '../../../../../components/responsive-rows/responsive-rows';
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

/** One scope's skills: a table from tablet up, stacked rows on a phone. */
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
  const runControl = ({ skill: item }: SkillRow) =>
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
    );
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
            cell: runControl,
          },
        ]
      : []),
  ];
  return (
    <ResponsiveRows
      label="Skills"
      rows={rows}
      getRowId={(row) => row.skill.id}
      columns={columns}
      stacked={(row) => (
        <div className="flex min-w-0 items-start justify-between gap-3">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="break-all font-mono text-sm">
              {row.skill.invocation}
            </span>
            <span className="line-clamp-2 text-xs text-ink-2">
              {row.skill.description ?? '—'}
            </span>
            <span className="text-xs text-ink-3">
              {row.skill.runtime} · {provenanceLabel(row.skill)}
              {row.profiles.length > 0
                ? ` · ${profilesLabel(row.profiles)}`
                : ''}
            </span>
          </span>
          {canOperate ? (
            <span className="shrink-0">{runControl(row)}</span>
          ) : null}
        </div>
      )}
    />
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
  const router = useRouter();
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
        link={Link}
        action={{ label: 'Open Projects', href: '/projects' }}
      />
    );
  }

  const canOperate = canRun;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <PageHeader
          className="mb-0"
          link={Link}
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
          primaryAction={
            canOperate
              ? {
                  label: refreshing ? 'Scanning…' : 'Rescan',
                  icon: RefreshCw,
                  onClick: () => {
                    if (!refreshing) void refresh();
                  },
                }
              : undefined
          }
          overflow={
            canOperate
              ? [
                  {
                    id: 'find',
                    label: 'Find skills',
                    icon: Search,
                    onSelect: () => router.push('/skills'),
                  },
                ]
              : undefined
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
            link={Link}
            action={{ label: 'Find skills', href: '/skills' }}
          />
        }
      >
        {() =>
          groups.map((group) => (
            <Section
              key={group.scope}
              surface="none"
              pad="none"
              title={SCOPE_LABEL[group.scope]}
              className="mb-6 last:mb-0"
            >
              <SkillRows
                items={group.items}
                canOperate={canOperate}
                onRun={setRunning}
              />
            </Section>
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
