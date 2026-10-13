'use client';

import type {
  InstalledSkillsView,
  InstalledSkillView,
  ProjectRuntimeProfile,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { Play } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
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
  skillRunProfiles,
  skillRunsHref,
} from '../../../../../lib/skills/format';
import { useProjectDetail } from '../use-project-detail';
import { RunDialog } from './run-dialog';

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
  return (
    <ScrollX label="Skills" edgeClassName="from-surface">
      <Table>
        <TableHead>
          <TableRow>
            <TableCell head>Skill</TableCell>
            <TableCell head>Runtime</TableCell>
            <TableCell head>Source</TableCell>
            <TableCell head>Description</TableCell>
            {canOperate ? (
              <TableCell head>
                <span className="sr-only">Run</span>
              </TableCell>
            ) : null}
          </TableRow>
        </TableHead>
        <tbody>
          {rows.map(({ skill: item, profiles }) => (
            <TableRow key={item.id} className="group">
              <TableCell>
                <span className="font-mono text-sm break-normal whitespace-nowrap">
                  {item.invocation}
                </span>
                {profiles.length > 0 ? (
                  <div className="text-xs text-ink-3">
                    <Tooltip content={profiles.join(', ')}>
                      <button type="button" className="cursor-help">
                        {profilesLabel(profiles)}
                      </button>
                    </Tooltip>
                  </div>
                ) : null}
              </TableCell>
              <TableCell>
                <Badge tone="neutral" label={item.runtime} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {provenanceLabel(item)}
              </TableCell>
              <TableCell>
                <span className="line-clamp-2 min-w-48 text-sm text-ink-2">
                  {item.description ?? '—'}
                </span>
              </TableCell>
              {canOperate ? (
                <TableCell className="text-end">
                  {item.runnable && item.runtime === 'claude' ? (
                    <Tooltip content={`Run ${item.invocation}`}>
                      <Button
                        size="sm"
                        icon
                        aria-label={`Run ${item.invocation}`}
                        className="opacity-100 transition-opacity focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
                        onClick={() => onRun(item)}
                      >
                        <Play aria-hidden="true" className="size-4" />
                      </Button>
                    </Tooltip>
                  ) : (
                    <span className="text-xs text-ink-3">
                      {item.runnable ? 'Claude only' : 'Not runnable'}
                    </span>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </tbody>
      </Table>
    </ScrollX>
  );
}

export default function ProjectSkillsPage() {
  const { projectId } = useParams<{ projectId: string }>();
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

  if (skills.data === undefined && isNotFound(skills.error)) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
        action={
          <Link href="/projects" className="text-sm underline">
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
                className="underline underline-offset-2"
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
                <Link href="/skills">
                  <Button>Find skills</Button>
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
              <h2
                id={`scope-${group.scope}`}
                className="mb-2 text-sm font-semibold"
              >
                {SCOPE_LABEL[group.scope]}{' '}
                <span className="font-normal text-ink-3">
                  ({dedupeSkills(group.items).length})
                </span>
              </h2>
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
