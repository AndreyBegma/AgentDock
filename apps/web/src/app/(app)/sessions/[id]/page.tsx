'use client';

import type {
  ProjectDetail,
  ProjectMemberView,
  SessionDetail,
  SessionTotals,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import {
  type KeyValueItem,
  KeyValueList,
} from '@andrewbehma/glass-ui/key-value-list';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { TraceTree } from '@andrewbehma/glass-ui/trace-tree';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SummaryPanel } from '../../../../components/ai/summary-panel';
import { PageHeader } from '../../../../components/page-header/page-header';
import { ScrollX } from '../../../../components/scroll-x/scroll-x';
import { AttachManualButton } from '../../../../components/sessions/attach-manual-button';
import {
  LiveStatePill,
  OriginBadge,
} from '../../../../components/sessions/origin-badge';
import { SessionContentTimeline } from '../../../../components/sessions/session-content-timeline';
import { useCurrentUser } from '../../../../components/shell/user-context';
import { summarizeSession } from '../../../../lib/ai/actions';
import { canSummarizeSession } from '../../../../lib/ai/format';
import { ApiError, api } from '../../../../lib/api';
import { formatNumber, pluralize } from '../../../../lib/format';
import { Time } from '../../../../lib/format/time';
import { useLive } from '../../../../lib/live/use-live';
import { useSection } from '../../../../lib/section/use-section';
import {
  canReadContent,
  issueUrl,
  ownerLabel,
} from '../../../../lib/sessions/content';
import {
  buildTrace,
  describeSessionError,
  formatCost,
  formatDuration,
  formatTokens,
  liveTopicFor,
  nodeSpan,
  QUERY_SOURCE_LABEL,
  sessionName,
  type TreeNodeInfo,
  tokenSum,
} from '../../../../lib/sessions/format';

const figure = (value: string) => <span className="num">{value}</span>;

function totalsItems(totals: SessionTotals): KeyValueItem[] {
  const tokens = (key: string, label: string, value: number) => ({
    key,
    label,
    value: figure(formatNumber(value)),
  });
  return [
    tokens('input', 'Input tokens', totals.input),
    tokens('output', 'Output tokens', totals.output),
    tokens('reasoning', 'Reasoning (inside output)', totals.reasoning),
    tokens('cacheRead', 'Cache read', totals.cacheRead),
    tokens('cacheWrite5m', 'Cache write, 5 min', totals.cacheWrite5m),
    tokens('cacheWrite1h', 'Cache write, 1 h', totals.cacheWrite1h),
    {
      key: 'requests',
      label: 'Requests',
      value: figure(formatNumber(totals.requests)),
    },
    { key: 'cost', label: 'Cost', value: figure(formatCost(totals.costUsd)) },
  ];
}

function describeNode(info: TreeNodeInfo): {
  title: string;
  totals: SessionTotals;
  facts: KeyValueItem[];
} {
  switch (info.kind) {
    case 'session': {
      const s = info.node.session;
      return {
        title: sessionName(s),
        totals: info.node.totals,
        facts: [
          { key: 'runtime', label: 'Runtime', value: s.runtime },
          { key: 'models', label: 'Models', value: s.models.join(', ') || '—' },
          {
            key: 'turns',
            label: 'Turns',
            value: figure(formatNumber(s.turns)),
          },
          {
            key: 'tools',
            label: 'Tool calls',
            value: figure(formatNumber(s.toolCalls)),
          },
          {
            key: 'external',
            label: 'Runtime session id',
            value: <span className="font-mono text-xs">{s.externalId}</span>,
            copyValue: s.externalId,
          },
        ],
      };
    }
    case 'turn':
      return {
        title: `Turn ${info.index + 1}`,
        totals: info.turn.totals,
        facts: [
          {
            key: 'started',
            label: 'Started',
            value: <Time value={info.turn.startedAt} format="time" />,
          },
          {
            key: 'requests',
            label: 'Requests',
            value: figure(formatNumber(info.turn.requests.length)),
          },
          {
            key: 'tools',
            label: 'Tool calls',
            value: figure(formatNumber(info.turn.tools.length)),
          },
        ],
      };
    case 'request': {
      const r = info.request;
      return {
        title: r.model,
        totals: r.totals,
        facts: [
          {
            key: 'source',
            label: 'Thread',
            value: QUERY_SOURCE_LABEL[r.querySource] ?? r.querySource,
          },
          {
            key: 'duration',
            label: 'Duration',
            value: figure(
              `${formatDuration(r.durationMs)}${r.durationApprox ? ' (approx.)' : ''}`,
            ),
          },
          { key: 'stop', label: 'Stop reason', value: r.stopReason ?? '—' },
        ],
      };
    }
    case 'tool': {
      const t = info.tool;
      return {
        title: t.name,
        totals: t.totals,
        facts: [
          {
            key: 'result',
            label: 'Result',
            value:
              t.ok === null ? (
                <Badge tone="neutral" label="No result yet" />
              ) : t.ok ? (
                <Badge tone="ok" label="Succeeded" />
              ) : (
                <Badge tone="danger" label="Failed" />
              ),
          },
          {
            key: 'child',
            label: 'Subagent',
            value: t.child ? sessionName(t.child.session) : 'None',
          },
        ],
      };
    }
    case 'group':
      return { title: info.label, totals: info.totals, facts: [] };
  }
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const [detail, setDetail] = useState<SessionDetail>();
  const [missing, setMissing] = useState(false);
  // Any failure but "not found": say so and offer a retry, never a skeleton forever.
  const [failure, setFailure] = useState<unknown>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | undefined>();
  const seeded = useRef(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api<SessionDetail>(`/sessions/${id}`));
      setMissing(false);
      setFailure(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setMissing(true);
      } else {
        setFailure(err);
      }
    }
  }, [id]);

  useEffect(() => {
    seeded.current = false;
    setDetail(undefined);
    setMissing(false);
    setFailure(null);
    load();
  }, [load]);

  const topic = detail
    ? (liveTopicFor({ projectId: detail.session.projectId }) ??
      liveTopicFor({ unassigned: true }))
    : null;
  useLive(topic, (message) => {
    if (message.event !== 'sessions.changed') return;
    const ids = (message.data as { sessionIds?: string[] } | null)?.sessionIds;
    // The change may touch this session or any subagent below it; reloading is cheap.
    if (!ids || ids.length > 0) load();
  });

  const trace = useMemo(() => (detail ? buildTrace(detail) : null), [detail]);

  // Open the root and its turns once; later live reloads keep the reader's choices.
  useEffect(() => {
    if (!trace || seeded.current) return;
    seeded.current = true;
    setExpanded(new Set(trace.defaultExpanded));
    setSelected(trace.nodes[0]?.id);
  }, [trace]);

  const projectId = detail?.session.projectId ?? null;
  // The caller's role gates the content; the members name the owner. Both are
  // optional context: the page never waits on them.
  const project = useSection(
    () =>
      projectId
        ? api<ProjectDetail>(`/projects/${projectId}`)
        : Promise.resolve(null),
    [projectId],
  ).data;
  const members = useSection(
    () =>
      projectId
        ? api<ProjectMemberView[]>(`/projects/${projectId}/members`)
        : Promise.resolve(null),
    [projectId],
  ).data;

  const name = detail ? sessionName(detail.session) : null;
  useEffect(() => {
    if (name) document.title = `${name} · Sessions · AgentDock`;
  }, [name]);

  if (missing) {
    return (
      <EmptyState
        title="Session not found"
        description="It does not exist, or you are not a member of its project."
        action={
          <Link
            href="/sessions"
            className={buttonClassName({ variant: 'glass' })}
          >
            Back to sessions
          </Link>
        }
      />
    );
  }
  if (!detail || !trace) {
    if (failure !== null) {
      return (
        <SectionUnavailable
          title="This session could not be loaded"
          stillWorks={`${describeSessionError(failure)} The sessions list is unaffected.`}
          action={
            <Button variant="glass" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      );
    }
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const s = detail.session;
  const issueHref = s.issue ? issueUrl(project?.repo, s.issue) : null;
  const showContent =
    s.hasContent === true &&
    projectId !== null &&
    canReadContent(project?.role);
  const canSummarize =
    showContent &&
    canSummarizeSession({
      hasContent: s.hasContent,
      shipSessionContent: project?.shipSessionContent,
    });
  const origin = Date.parse(s.startedAt);
  const info = selected ? trace.info.get(selected) : undefined;
  const node = info ? describeNode(info) : null;
  const span = info ? nodeSpan(info) : null;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/sessions" className="hover:underline">
            Sessions
          </Link>
        }
        title={sessionName(s)}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone="neutral" label={s.runtime} />
            {s.parsed ? null : (
              <Tooltip content="The runner reported this session, but its transcript has not been read yet. Turns, tokens and cost may be missing.">
                <button type="button">
                  <Badge tone="warn" label="Not yet read" />
                </button>
              </Tooltip>
            )}
            <OriginBadge session={s} />
            <LiveStatePill session={s} />
            <span>{s.projectName ?? 'No project'}</span>
            {s.slotName ? <span>· slot {s.slotName}</span> : null}
            {s.issue ? (
              <span>
                ·{' '}
                {issueHref ? (
                  <a
                    href={issueHref}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-ink underline underline-offset-2"
                  >
                    issue #{s.issue}
                  </a>
                ) : (
                  `issue #${s.issue}`
                )}
              </span>
            ) : null}
            {s.ownerId ? (
              <span>
                · owner {ownerLabel(s.ownerId, user.id, members ?? undefined)}
              </span>
            ) : null}
            {s.gitBranch ? (
              <span className="font-mono text-xs">· {s.gitBranch}</span>
            ) : null}
            <span>
              · <Time value={s.startedAt} />
            </span>
            <span className="num">· {formatDuration(s.durationMs)}</span>
          </span>
        }
        actions={
          <AttachManualButton
            projectId={projectId}
            sessionId={s.id}
            runnerId={s.runnerId}
            tmuxSession={s.tmuxSession}
            isAdmin={isAdmin}
            title={sessionName(s)}
          />
        }
      />

      <div className="mb-6 flex flex-wrap gap-2">
        <Badge tone="neutral" label={pluralize(s.turns, 'turn')} />
        <Badge
          tone="neutral"
          label={pluralize(detail.totals.requests, 'request')}
        />
        <Badge tone="neutral" label={pluralize(s.toolCalls, 'tool call')} />
        <Badge tone="neutral" label={pluralize(s.subagents, 'subagent')} />
        <Badge
          tone="neutral"
          label={`${formatTokens(tokenSum(detail.totals))} tokens`}
        />
        <Badge tone="neutral" label={formatCost(detail.totals.costUsd)} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <ScrollX className="min-w-0">
          <TraceTree
            aria-label="Session trace: turns, model requests and tool calls over time"
            nodes={trace.nodes}
            expanded={expanded}
            onExpandedChange={setExpanded}
            selected={selected}
            onSelect={setSelected}
            labels={{ meta: 'Detail', totals: 'Tokens · cost' }}
            className="min-w-[40rem]"
          />
        </ScrollX>

        {node ? (
          <Card
            pad="lg"
            className="flex h-fit flex-col gap-4 xl:sticky xl:top-4"
          >
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold tracking-tight">
                {node.title}
              </h2>
              {span ? (
                <p className="num text-xs text-ink-3">
                  {formatDuration(span[1] - span[0])} · starts{' '}
                  {formatDuration(Math.max(0, span[0] - origin))} into the
                  session
                </p>
              ) : null}
            </div>
            {node.facts.length > 0 ? (
              <KeyValueList items={node.facts} columns={1} dense />
            ) : null}
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-ink-2">
                Tokens and cost
              </h3>
              <KeyValueList
                items={totalsItems(node.totals)}
                columns={1}
                dense
              />
            </div>
            <KeyValueList
              items={[
                {
                  key: 'cwd',
                  label: 'Working directory',
                  value: <span className="font-mono text-xs">{s.cwd}</span>,
                  copyValue: s.cwd,
                },
              ]}
              columns={1}
              dense
            />
          </Card>
        ) : null}
      </div>

      {canSummarize && projectId ? (
        <Card pad="md" className="mt-6">
          <SummaryPanel
            key={s.id}
            title="Summary"
            headingId="session-summary"
            hint="What was asked, what the agent did and what remains, from the session's stored content."
            summarize={(regenerate) =>
              summarizeSession(projectId, s.id, regenerate)
            }
          />
        </Card>
      ) : null}

      {showContent && projectId ? (
        <SessionContentTimeline
          projectId={projectId}
          sessionId={s.id}
          refreshKey={s.lastEventAt}
        />
      ) : null}
    </>
  );
}
