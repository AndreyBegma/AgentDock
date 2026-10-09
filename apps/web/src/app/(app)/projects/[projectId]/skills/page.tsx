'use client';

import type {
  AdminRunnerDetail,
  InstalledSkillsView,
  InstalledSkillView,
  ProjectDetail,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { EmptyState } from 'glass-ui/empty-state';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../../../lib/api';
import { formatAgo } from '../../../../../lib/fleet/format';
import {
  COMMAND_UNAVAILABLE_TEXT,
  describeSkillsError,
  groupBySkillScope,
  isCommandUnavailable,
  isNotFound,
  profileKeysFrom,
  provenanceLabel,
  SCOPE_LABEL,
} from '../../../../../lib/skills/format';
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
                    {item.runnable ? 'Claude only' : 'not runnable'}
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
  const [project, setProject] = useState<ProjectDetail>();
  const [view, setView] = useState<InstalledSkillsView>();
  const [adminProfiles, setAdminProfiles] = useState<string[]>([]);
  const [missing, setMissing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState<InstalledSkillView | null>(null);

  const load = useCallback(async () => {
    try {
      const [detail, skills] = await Promise.all([
        api<ProjectDetail>(`/projects/${projectId}`),
        api<InstalledSkillsView>(`/projects/${projectId}/skills`),
      ]);
      setProject(detail);
      setView(skills);
      setMissing(false);
    } catch (err) {
      if (isNotFound(err)) setMissing(true);
      else toast.error(describeSkillsError(err));
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // Only an admin can read the runner's profile list; others get the keys the inventory knows.
  const runnerId = project?.runnerId;
  const isAdmin = project?.role === 'admin';
  useEffect(() => {
    if (!isAdmin || !runnerId) return;
    api<AdminRunnerDetail>(`/admin/runners/${runnerId}`)
      .then((runner) =>
        setAdminProfiles(
          runner.profiles
            .filter((p) => !p.missing && p.runtime === 'claude')
            .map((p) => p.key),
        ),
      )
      .catch(() => setAdminProfiles([]));
  }, [isAdmin, runnerId]);

  const refresh = async () => {
    setRefreshing(true);
    setUnavailable(false);
    try {
      setView(
        await api<InstalledSkillsView>(`/projects/${projectId}/skills/refresh`, {
          method: 'POST',
        }),
      );
      toast.success('Skills rescanned.');
    } catch (err) {
      if (isCommandUnavailable(err)) setUnavailable(true);
      else toast.error(describeSkillsError(err));
    } finally {
      setRefreshing(false);
    }
  };

  const groups = useMemo(() => groupBySkillScope(view?.items ?? []), [view]);
  const profileKeys = useMemo(
    () =>
      isAdmin && adminProfiles.length > 0
        ? adminProfiles
        : profileKeysFrom(view?.items ?? [], project?.defaultProfileId ?? null),
    [isAdmin, adminProfiles, view, project],
  );

  if (missing) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
      />
    );
  }
  if (!view || !project) return <Skeleton className="h-64 w-full" />;

  const canOperate = project.role !== 'viewer';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Skills</h1>
          <p className="text-sm text-ink-2">
            Skills installed in this project, in the runner’s runtime profiles
            and in its plugins.{' '}
            {view.scannedAt
              ? `Scanned ${formatAgo(view.scannedAt)}.`
              : 'Not scanned yet.'}
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

      {unavailable ? (
        <Banner tone="warn" title="The runner cannot scan skills yet">
          {COMMAND_UNAVAILABLE_TEXT} The list below is the last scan.
        </Banner>
      ) : null}

      {groups.length === 0 ? (
        <EmptyState
          title="No skills found"
          description={
            view.scannedAt
              ? 'The last scan found no skill for this project.'
              : 'Nothing has been scanned yet. A rescan asks the runner to look.'
          }
        />
      ) : (
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
      )}

      <RunDialog
        projectId={projectId}
        skill={running}
        profileKeys={profileKeys}
        isAdmin={isAdmin}
        onOpenChange={(open) => {
          if (!open) setRunning(null);
        }}
      />
    </div>
  );
}
