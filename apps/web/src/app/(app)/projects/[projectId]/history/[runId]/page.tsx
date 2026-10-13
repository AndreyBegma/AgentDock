'use client';

import {
  RUN_UPDATED_LIVE_EVENT,
  type RunDetail,
  type RunSession,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { Timeline } from '@andrewbehma/glass-ui/timeline';
import { toast } from '@andrewbehma/glass-ui/toast';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from '../../../../../../components/markdown/markdown';
import { PageHeader } from '../../../../../../components/page-header/page-header';
import {
  isNotFound,
  toTimelineItem,
} from '../../../../../../lib/activity/format';
import { api, describeError } from '../../../../../../lib/api';
import {
  CHECKPOINT_LABEL,
  CHECKPOINT_TONE,
  safeHttpsUrl,
} from '../../../../../../lib/fleet/format';
import { formatNumber } from '../../../../../../lib/format';
import { Time } from '../../../../../../lib/format/time';
import {
  costLabel,
  parseRunUpdate,
  prLabel,
  READABLE_BADGE,
  RUN_KIND_LABEL,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  runTitle,
  runtimeLabel,
  tokensLabel,
} from '../../../../../../lib/history/format';
import { useLive } from '../../../../../../lib/live/use-live';
import { formatDuration } from '../../../../../../lib/sessions/format';
import { ProjectRunnerBanner } from '../../project-runner-banner';
import { ActorIcon } from './actor-icon';

const REFETCH_DEBOUNCE_MS = 300;

function SessionsTable({ sessions }: { sessions: RunSession[] }) {
  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No sessions"
        description="No agent session of this slot was reported within the run."
      />
    );
  }
  return (
    <Table scroll>
      <TableHead>
        <TableRow>
          <TableCell head>Session</TableCell>
          <TableCell head>Runtime</TableCell>
          <TableCell head>Started</TableCell>
          <TableCell head>Requests</TableCell>
          <TableCell head>Tokens</TableCell>
          <TableCell head>Cost</TableCell>
        </TableRow>
      </TableHead>
      <tbody>
        {sessions.map((session) => (
          <TableRow key={session.id}>
            <TableCell>
              <Link
                href={`/sessions/${session.id}`}
                className="underline-offset-2 hover:underline"
              >
                {session.title ?? session.externalId.slice(0, 8)}
              </Link>
            </TableCell>
            <TableCell>
              <Badge tone="neutral" label={session.runtime} />
            </TableCell>
            <TableCell>
              <Time value={session.startedAt} />
            </TableCell>
            <TableCell className="num">
              {formatNumber(session.usage.requests)}
            </TableCell>
            <TableCell className="num">{tokensLabel(session.usage)}</TableCell>
            <TableCell className="num">{costLabel(session.usage)}</TableCell>
          </TableRow>
        ))}
      </tbody>
    </Table>
  );
}

export default function RunDetailPage() {
  const { projectId, runId } = useParams<{
    projectId: string;
    runId: string;
  }>();
  const [run, setRun] = useState<RunDetail>();
  const [missing, setMissing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setRun(await api<RunDetail>(`/projects/${projectId}/runs/${runId}`));
    } catch (err) {
      if (isNotFound(err)) setMissing(true);
      else toast.error(describeError(err));
    }
  }, [projectId, runId]);

  useEffect(() => {
    load();
  }, [load]);

  useLive(`project:${projectId}`, (message) => {
    if (message.event !== RUN_UPDATED_LIVE_EVENT) return;
    if (parseRunUpdate(message.data)?.id !== runId) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(load, REFETCH_DEBOUNCE_MS);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

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

  const prUrl = safeHttpsUrl(run.prUrl);
  return (
    <>
      <PageHeader
        className="mb-4"
        eyebrow={
          <Link
            href={`/projects/${projectId}/history`}
            className="underline-offset-2 hover:underline"
          >
            ← History
          </Link>
        }
        title={
          <>
            {runTitle(run)}
            <span className="sr-only"> — </span>
            <Badge
              className={READABLE_BADGE}
              tone={RUN_STATUS_TONE[run.status]}
              label={RUN_STATUS_LABEL[run.status]}
            />
          </>
        }
      />
      <div className="mb-4">
        <ProjectRunnerBanner projectId={projectId} />
      </div>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold">Summary</h2>
        <KeyValueList
          items={[
            { key: 'title', label: 'Title', value: runTitle(run) },
            { key: 'kind', label: 'Kind', value: RUN_KIND_LABEL[run.kind] },
            {
              key: 'runtime',
              label: 'Runtime / model',
              value: runtimeLabel(run),
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
                  {prLabel(run)}
                </a>
              ) : (
                prLabel(run)
              ),
            },
            {
              key: 'outcome',
              label: 'Outcome',
              value: run.outcome ? (
                <Markdown compact>{run.outcome}</Markdown>
              ) : (
                '—'
              ),
            },
            {
              key: 'started',
              label: 'Started',
              value: <Time value={run.startedAt} format="datetime" />,
            },
            {
              key: 'ended',
              label: 'Ended',
              value: <Time value={run.endedAt} format="datetime" />,
            },
            {
              key: 'duration',
              label: 'Duration',
              value: formatDuration(run.durationMs),
            },
            {
              key: 'requests',
              label: 'Requests',
              value: formatNumber(run.usage.requests),
            },
            { key: 'tokens', label: 'Tokens', value: tokensLabel(run.usage) },
            { key: 'cost', label: 'Cost', value: costLabel(run.usage) },
          ]}
        />
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold">Checkpoints</h2>
        <Timeline
          items={run.checkpoints.map((checkpoint) => ({
            id: `${checkpoint.position}`,
            at: checkpoint.at,
            tone: CHECKPOINT_TONE[checkpoint.kind],
            title: checkpoint.heading || CHECKPOINT_LABEL[checkpoint.kind],
            meta: checkpoint.summary ? (
              <Markdown compact>{checkpoint.summary}</Markdown>
            ) : (
              CHECKPOINT_LABEL[checkpoint.kind]
            ),
          }))}
          dayHeadingLevel={3}
          empty={<EmptyState title="No checkpoints" />}
        />
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold">Sessions</h2>
        <SessionsTable sessions={run.sessions} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Related activity</h2>
        <Timeline
          items={run.activity.map((item) => ({
            ...toTimelineItem(item),
            actor: undefined,
            icon: <ActorIcon type={item.actorType} />,
          }))}
          dayHeadingLevel={3}
          empty={<EmptyState title="No related activity" />}
        />
      </section>
    </>
  );
}
