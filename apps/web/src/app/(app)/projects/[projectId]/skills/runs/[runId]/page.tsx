'use client';

import { RUN_UPDATED_LIVE_EVENT, type SkillRunDetail } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { CodeBlock } from 'glass-ui/code-block';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { KeyValueList } from 'glass-ui/key-value-list';
import { Skeleton } from 'glass-ui/skeleton';
import { Spinner } from 'glass-ui/spinner';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../../../../../lib/api';
import { safeHttpsUrl } from '../../../../../../../lib/fleet/format';
import { parseRunUpdate } from '../../../../../../../lib/history/format';
import { useLive } from '../../../../../../../lib/live/use-live';
import {
  formatDuration,
  formatTime,
} from '../../../../../../../lib/sessions/format';
import {
  describeSkillsError,
  isActivePhase,
  isNotFound,
  SKILL_OUTPUT_LABEL,
  SKILL_PHASE_LABEL,
  SKILL_PHASE_TONE,
} from '../../../../../../../lib/skills/format';
import { RunLogPanel } from './log-panel';

const REFETCH_DEBOUNCE_MS = 300;

const FILE_STATUS_LABEL = (status: string): string => {
  const code = status.trim();
  if (code === '??') return 'new';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  return 'modified';
};

const durationMs = (run: SkillRunDetail): number | null => {
  if (!run.startedAt) return null;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  return Math.max(0, end - Date.parse(run.startedAt));
};

export default function SkillRunPage() {
  const { projectId, runId } = useParams<{
    projectId: string;
    runId: string;
  }>();
  const [run, setRun] = useState<SkillRunDetail>();
  const [missing, setMissing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [role, setRole] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setRun(
        await api<SkillRunDetail>(`/projects/${projectId}/skill-runs/${runId}`),
      );
    } catch (err) {
      if (isNotFound(err)) setMissing(true);
      else toast.error(describeSkillsError(err));
    }
  }, [projectId, runId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<{ role: string }>(`/projects/${projectId}`)
      .then((project) => setRole(project.role))
      .catch(() => setRole('viewer'));
  }, [projectId]);

  useLive(`project:${projectId}`, (message) => {
    if (message.event !== RUN_UPDATED_LIVE_EVENT) return;
    if (parseRunUpdate(message.data)?.id !== runId) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(load, REFETCH_DEBOUNCE_MS);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const cancel = async () => {
    setCancelling(true);
    try {
      // The answer is the bare run; the page re-reads the detail.
      await api(`/projects/${projectId}/skill-runs/${runId}/cancel`, {
        method: 'POST',
      });
      setConfirming(false);
      await load();
      toast.success('Cancel requested.');
    } catch (err) {
      toast.error(describeSkillsError(err));
    } finally {
      setCancelling(false);
    }
  };

  if (missing) {
    return (
      <EmptyState
        title="Run not found"
        description="It does not exist, or you are not a member of this project."
      />
    );
  }
  if (!run) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const active = isActivePhase(run.phase);
  const canOperate = role !== undefined && role !== 'viewer';
  const prUrl = safeHttpsUrl(run.prUrl);
  const files = run.changedFiles ?? [];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="mb-1 text-sm text-ink-3">
          <Link
            href={`/projects/${projectId}/skills`}
            className="underline-offset-2 hover:underline"
          >
            Skills
          </Link>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-3 text-xl font-semibold">
            <span className="font-mono">/{run.skill}</span>
            <Badge
              tone={SKILL_PHASE_TONE[run.phase]}
              label={SKILL_PHASE_LABEL[run.phase]}
            />
            {active ? (
              <Spinner size="sm" label={SKILL_PHASE_LABEL[run.phase]} />
            ) : null}
          </h1>
          {active && canOperate ? (
            <Button variant="glass" onClick={() => setConfirming(true)}>
              Cancel run
            </Button>
          ) : null}
        </div>
      </div>

      {run.error ? (
        <Banner tone="danger" title="The run failed">
          {run.error}
        </Banner>
      ) : null}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Summary</h2>
        <KeyValueList
          items={[
            {
              key: 'args',
              label: 'Arguments',
              value: run.args ? (
                <span className="whitespace-pre-wrap break-words font-mono text-sm">
                  {run.args}
                </span>
              ) : (
                '—'
              ),
            },
            { key: 'profile', label: 'Profile', value: run.profileKey },
            { key: 'model', label: 'Model', value: run.model },
            {
              key: 'mode',
              label: 'Permission mode',
              value: run.permissionMode,
            },
            {
              key: 'output',
              label: 'Output',
              value: SKILL_OUTPUT_LABEL[run.output],
            },
            {
              key: 'queued',
              label: 'Queued',
              value: formatTime(run.queuedAt),
            },
            {
              key: 'started',
              label: 'Started',
              value: run.startedAt ? formatTime(run.startedAt) : '—',
            },
            {
              key: 'finished',
              label: 'Finished',
              value: run.finishedAt ? formatTime(run.finishedAt) : '—',
            },
            {
              key: 'duration',
              label: 'Duration',
              value: formatDuration(durationMs(run)),
            },
            {
              key: 'exit',
              label: 'Exit code',
              value: run.exitCode ?? '—',
            },
            {
              key: 'pr',
              label: 'Pull request',
              value: prUrl ? (
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline-offset-2 hover:underline"
                >
                  {run.prNumber ? `#${run.prNumber}` : prUrl}
                </a>
              ) : (
                '—'
              ),
            },
          ]}
        />
      </section>

      {active ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Live log</h2>
          {run.phase === 'queued' ? (
            <p className="mb-2 text-sm text-ink-2">
              Waiting for a free slot on the runner. The log starts when the run
              does.
            </p>
          ) : null}
          <RunLogPanel projectId={projectId} runId={runId} onEnded={load} />
        </section>
      ) : (
        <>
          <section>
            <h2 className="mb-2 text-sm font-semibold">Report</h2>
            {run.reportText ? (
              <>
                <CodeBlock code={run.reportText} defaultWrap maxHeight={480} />
                {run.reportTruncated ? (
                  <p className="mt-1 text-xs text-ink-3">
                    The report was cut to fit. The full text stays on the
                    runner.
                  </p>
                ) : null}
              </>
            ) : (
              <EmptyState
                title="No report"
                description="The run ended without a final message."
              />
            )}
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold">
              Changed files{' '}
              <span className="font-normal text-ink-3">
                ({run.changedFilesTotal ?? files.length})
              </span>
            </h2>
            {files.length === 0 ? (
              <EmptyState
                title="No changes"
                description="The run did not change any file."
              />
            ) : (
              <Table scroll>
                <TableHead>
                  <TableRow>
                    <TableCell head>Change</TableCell>
                    <TableCell head>Path</TableCell>
                  </TableRow>
                </TableHead>
                <tbody>
                  {files.map((file) => (
                    <TableRow key={`${file.status}:${file.path}`}>
                      <TableCell>{FILE_STATUS_LABEL(file.status)}</TableCell>
                      <TableCell>
                        <span className="font-mono text-sm">{file.path}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </tbody>
              </Table>
            )}
            {run.changedFilesTotal !== null &&
            run.changedFilesTotal > files.length ? (
              <p className="mt-1 text-xs text-ink-3">
                Showing {files.length} of {run.changedFilesTotal} files.
              </p>
            ) : null}
          </section>

          {run.patch ? (
            <section>
              <h2 className="mb-2 text-sm font-semibold">Patch</h2>
              <CodeBlock code={run.patch} language="diff" maxHeight={560} />
              {run.patchTruncated ? (
                <p className="mt-1 text-xs text-ink-3">
                  The patch was cut at 128 KB. The full patch stays on the
                  runner.
                </p>
              ) : null}
            </section>
          ) : null}
        </>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Sessions and usage</h2>
        {run.run.sessions.length > 0 ? (
          <Table scroll>
            <TableHead>
              <TableRow>
                <TableCell head>Session</TableCell>
                <TableCell head>Requests</TableCell>
              </TableRow>
            </TableHead>
            <tbody>
              {run.run.sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <Link
                      href={`/sessions/${session.id}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {session.title ?? session.externalId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>{session.usage.requests}</TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            title="Not linked yet"
            description="This run’s sessions, tokens and cost are not linked to it yet, so none are shown. That is not a zero."
          />
        )}
      </section>

      <DialogRoot
        open={confirming}
        onOpenChange={(open) => {
          if (!cancelling) setConfirming(open);
        }}
      >
        <DialogContent
          title="Cancel this run?"
          description="The runner stops the session and collects what it has. The run ends as cancelled."
          footer={
            <>
              <Button
                variant="glass"
                disabled={cancelling}
                onClick={() => setConfirming(false)}
              >
                Keep running
              </Button>
              <Button disabled={cancelling} onClick={cancel}>
                {cancelling ? 'Cancelling…' : 'Cancel run'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-2">
            The report, changed files and patch are still collected.
          </p>
        </DialogContent>
      </DialogRoot>
    </div>
  );
}
