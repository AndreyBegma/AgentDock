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
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { RunnerOfflineBanner } from '../../../../../components/prerequisites/prerequisite-banner';
import { api } from '../../../../../lib/api';
import { formatAgo } from '../../../../../lib/fleet/format';
import { useSection } from '../../../../../lib/section/use-section';
import {
  commandUnavailableText,
  describeSkillsError,
  groupBySkillScope,
  isCommandUnavailable,
  isNotFound,
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
  return (
    <Table scroll>
      <TableHead>
        <TableRow>
          <TableCell head>Skill</TableCell>
          <TableCell head>Runtime</TableCell>
          <TableCell head>Source</TableCell>
          <TableCell head>Description</TableCell>
          {canOperate ? <TableCell head>Run</TableCell> : null}
        </TableRow>
      </TableHead>
      <tbody>
        {items.map((item) => (
          <TableRow key={item.id}>
            <TableCell>
              <span className="font-mono text-sm">{item.invocation}</span>
              {item.scope === 'profile' && item.profileKey ? (
                <div className="text-xs text-ink-3">
                  profile {item.profileKey}
                </div>
              ) : null}
            </TableCell>
            <TableCell>
              <Badge tone="neutral" label={item.runtime} />
            </TableCell>
            <TableCell>{provenanceLabel(item)}</TableCell>
            <TableCell>
              <span className="line-clamp-2 text-sm text-ink-2">
                {item.description ?? '—'}
              </span>
            </TableCell>
            {canOperate ? (
              <TableCell>
                {item.runnable && item.runtime === 'claude' ? (
                  <Button size="sm" onClick={() => onRun(item)}>
                    Run
                  </Button>
                ) : (
                  <span className="text-xs text-ink-3">
                    {item.runnable
                      ? 'Only Claude skills can run here'
                      : 'Not runnable from here'}
                  </span>
                )}
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </tbody>
    </Table>
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Skills</h1>
            <p className="text-sm text-ink-2">
              Skills installed in this project, in the runner’s runtime profiles
              and in its plugins.{' '}
              {view
                ? view.scannedAt
                  ? `Scanned ${formatAgo(view.scannedAt)}.`
                  : 'Not scanned yet.'
                : null}{' '}
              <Link
                href={skillRunsHref(projectId)}
                className="underline underline-offset-2"
              >
                Recent runs
              </Link>
            </p>
          </div>
          {canOperate ? (
            <div className="flex gap-2">
              <Button variant="glass" disabled={refreshing} onClick={refresh}>
                {refreshing ? 'Scanning…' : 'Rescan'}
              </Button>
              <Link href="/skills">
                <Button>Find skills</Button>
              </Link>
            </div>
          ) : null}
        </div>
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
                  ({group.items.length})
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
