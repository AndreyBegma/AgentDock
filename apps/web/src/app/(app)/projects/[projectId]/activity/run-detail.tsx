'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { Timeline } from '@andrewbehma/glass-ui/timeline';
import {
  RUN_UPDATED_LIVE_EVENT,
  type RunDetail,
  type RunSession,
} from '@nautelle/shared';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from '../../../../../components/markdown/markdown';
import { isNotFound, toTimelineItem } from '../../../../../lib/activity/format';
import { api, describeErrorHint } from '../../../../../lib/api';
import {
  CHECKPOINT_LABEL,
  CHECKPOINT_TONE,
} from '../../../../../lib/fleet/format';
import { formatNumber } from '../../../../../lib/format';
import { Time } from '../../../../../lib/format/time';
import {
  costLabel,
  latestSession,
  parseRunUpdate,
  prLabel,
  RUN_KIND_LABEL,
  RUN_STATUS_LABEL,
  retryHref,
  runFailure,
  runTitle,
  runtimeLabel,
  tokensLabel,
} from '../../../../../lib/history/format';
import { useLive } from '../../../../../lib/live/use-live';
import { planHref } from '../../../../../lib/planner/href';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import { formatDuration } from '../../../../../lib/sessions/format';
import { RUN_PILL_STATUS } from '../../../../../lib/status/pill';
import { githubUrl } from '../../../../../lib/url';
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

/**
 * A run that did not get where it was going leads with why, and with what to
 * do next (#213): try again, look at the session, or update the runner when
 * it does not know the command.
 */
function FailureBanner({
  projectId,
  run,
}: {
  projectId: string;
  run: RunDetail;
}) {
  const failure = runFailure(run);
  if (!failure) return null;
  const retry = retryHref(projectId, run);
  const session = latestSession(run.sessions);
  const link = (variant: 'solid' | 'glass') =>
    buttonClassName({ variant, size: 'sm' });
  return (
    <Banner
      tone={failure.tone}
      title={failure.title}
      className="mb-6"
      action={
        <div className="flex flex-wrap gap-2">
          {failure.updateRunner ? (
            <Link href="/install" className={link('solid')}>
              Update the runner
            </Link>
          ) : null}
          {retry ? (
            <Link
              href={retry}
              className={link(failure.updateRunner ? 'glass' : 'solid')}
            >
              Retry
            </Link>
          ) : null}
          {session ? (
            <Link href={`/sessions/${session.id}`} className={link('glass')}>
              Open session
            </Link>
          ) : null}
        </div>
      }
    >
      <Markdown compact>{failure.cause}</Markdown>
    </Banner>
  );
}

/**
 * One run, beside the Runs tab (C-285): what History's run page showed, in a
 * pane. A side panel from tablet up, a sheet on a phone; the page draws the
 * frame and passes `onClose` when the pane needs its own way out.
 */
export function RunDetailPane({
  projectId,
  runId,
  onClose,
}: {
  projectId: string;
  runId: string;
  onClose?: () => void;
}) {
  const [run, setRun] = useState<RunDetail>();
  const [missing, setMissing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showError = useErrorToast();

  const load = useCallback(async () => {
    try {
      setRun(await api<RunDetail>(`/projects/${projectId}/runs/${runId}`));
    } catch (err) {
      if (isNotFound(err)) setMissing(true);
      else showError(describeErrorHint(err));
    }
  }, [projectId, runId, showError]);

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

  const close = onClose ? (
    <Button
      variant="ghost"
      size="sm"
      icon
      type="button"
      aria-label="Close the run"
      onClick={onClose}
    >
      <X aria-hidden className="size-4" />
    </Button>
  ) : null;

  if (missing) {
    return (
      <div className="flex flex-col gap-2">
        {close ? <div className="flex justify-end">{close}</div> : null}
        <EmptyState
          title="Run not found"
          description="It does not exist, or you are not a member of this project."
        />
      </div>
    );
  }
  if (!run) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const prUrl = githubUrl(run.prUrl);
  // Checkpoints, sessions and the feed are a worker slot's; other runs have none.
  const isSlot = run.kind === 'orchestrator_slot';
  return (
    <article aria-labelledby={`run-${run.id}`} className="min-w-0">
      <header className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink-3">{RUN_KIND_LABEL[run.kind]}</p>
          <h2
            id={`run-${run.id}`}
            className="text-lg font-semibold break-words text-ink"
          >
            {runTitle(run)}
          </h2>
          <StatusPill
            size="md"
            className="mt-2"
            status={RUN_PILL_STATUS[run.status]}
            label={RUN_STATUS_LABEL[run.status]}
          />
        </div>
        {close}
      </header>
      <FailureBanner projectId={projectId} run={run} />

      <section className="mb-8">
        <SectionHeader title="Summary" headingLevel={3} className="mb-2" />
        <KeyValueList
          items={[
            { key: 'title', label: 'Title', value: runTitle(run) },
            { key: 'kind', label: 'Kind', value: RUN_KIND_LABEL[run.kind] },
            ...(run.planId
              ? [
                  {
                    key: 'plan',
                    label: 'Plan',
                    value: (
                      <Link
                        href={planHref(projectId, run.planId)}
                        className="underline-offset-2 hover:underline"
                      >
                        Open the plan
                      </Link>
                    ),
                  },
                ]
              : []),
            {
              key: 'runtime',
              label: 'Runtime / model',
              value: runtimeLabel(run),
            },
            ...(isSlot || run.prNumber !== null
              ? [
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
                ]
              : []),
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

      {isSlot ? (
        <>
          <section className="mb-8">
            <SectionHeader
              title="Checkpoints"
              headingLevel={3}
              className="mb-2"
            />
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
              dayHeadingLevel={4}
              empty={<EmptyState title="No checkpoints" />}
            />
          </section>

          <section className="mb-8">
            <SectionHeader title="Sessions" headingLevel={3} className="mb-2" />
            <SessionsTable sessions={run.sessions} />
          </section>

          <section>
            <SectionHeader
              title="Related activity"
              headingLevel={3}
              className="mb-2"
            />
            <Timeline
              items={run.activity.map((item) => ({
                ...toTimelineItem(item),
                actor: undefined,
                icon: <ActorIcon type={item.actorType} />,
              }))}
              dayHeadingLevel={4}
              empty={<EmptyState title="No related activity" />}
            />
          </section>
        </>
      ) : null}
    </article>
  );
}
