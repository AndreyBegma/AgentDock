'use client';

import type { SessionDetail, SessionTotals } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { EmptyState } from 'glass-ui/empty-state';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { Tree } from 'glass-ui/tree';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../../../../lib/api';
import { useLive } from '../../../../lib/live/use-live';
import {
  barGeometry,
  buildTree,
  describeSessionError,
  formatCost,
  formatDuration,
  formatTime,
  formatTokens,
  liveTopicFor,
  nodeSpan,
  type TreeNodeInfo,
  tokenSum,
} from '../../../../lib/sessions/format';

function Bar({
  span,
  origin,
  total,
}: {
  span: [number, number];
  origin: number;
  total: number;
}) {
  const { left, width } = barGeometry(span, origin, total);
  return (
    <div
      className="relative h-2 w-full rounded-full bg-hover"
      role="img"
      aria-label={`${formatDuration(span[1] - span[0])}, starting ${formatDuration(span[0] - origin)} into the session`}
    >
      <div
        className="absolute inset-y-0 rounded-full bg-ink-2"
        style={{ left: `${left}%`, width: `${width}%` }}
      />
    </div>
  );
}

function TotalsTable({ totals }: { totals: SessionTotals }) {
  const rows: [string, number][] = [
    ['Input', totals.input],
    ['Output', totals.output],
    ['↳ reasoning (counted in output)', totals.reasoning],
    ['Cache read', totals.cacheRead],
    ['Cache write 5m', totals.cacheWrite5m],
    ['Cache write 1h', totals.cacheWrite1h],
  ];
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableCell head>Bucket</TableCell>
          <TableCell head>Tokens</TableCell>
        </TableRow>
      </TableHead>
      <tbody>
        {rows.map(([label, value]) => (
          <TableRow key={label}>
            <TableCell>{label}</TableCell>
            <TableCell>{value.toLocaleString()}</TableCell>
          </TableRow>
        ))}
        <TableRow>
          <TableCell>Requests</TableCell>
          <TableCell>{totals.requests}</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Cost</TableCell>
          <TableCell>{formatCost(totals.costUsd)}</TableCell>
        </TableRow>
      </tbody>
    </Table>
  );
}

function describeNode(info: TreeNodeInfo): {
  title: string;
  totals: SessionTotals;
  facts: [string, string][];
} {
  switch (info.kind) {
    case 'session': {
      const s = info.node.session;
      return {
        title: s.title ?? s.externalId,
        totals: info.node.totals,
        facts: [
          ['Runtime', s.runtime],
          ['Models', s.models.join(', ') || '—'],
          ['Turns', String(s.turns)],
          ['Tool calls', String(s.toolCalls)],
        ],
      };
    }
    case 'turn':
      return {
        title: `Turn ${info.index + 1}`,
        totals: info.turn.totals,
        facts: [
          ['Started', formatTime(info.turn.startedAt)],
          ['Prompt id', info.turn.promptId],
        ],
      };
    case 'request':
      return {
        title: info.request.model,
        totals: info.request.totals,
        facts: [
          ['Request id', info.request.requestId],
          ['Source', info.request.querySource],
          [
            'Duration',
            `${formatDuration(info.request.durationMs)}${info.request.durationApprox ? ' (approx.)' : ''}`,
          ],
          ['Stop reason', info.request.stopReason ?? '—'],
        ],
      };
    case 'tool':
      return {
        title: info.tool.name,
        totals: info.tool.totals,
        facts: [
          ['Tool use id', info.tool.toolUseId],
          [
            'Result',
            info.tool.ok === null ? 'pending' : info.tool.ok ? 'ok' : 'failed',
          ],
          ['Spawned a subagent', info.tool.child ? 'yes' : 'no'],
        ],
      };
    case 'group':
      return { title: info.label, totals: info.totals, facts: [] };
  }
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<SessionDetail>();
  const [missing, setMissing] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const seeded = useRef(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api<SessionDetail>(`/sessions/${id}`));
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setMissing(true);
      } else {
        toast.error(describeSessionError(err));
      }
    }
  }, [id]);

  useEffect(() => {
    seeded.current = false;
    setDetail(undefined);
    setMissing(false);
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

  const tree = useMemo(() => (detail ? buildTree(detail) : null), [detail]);

  // Open the root and its turns once; later live reloads keep the reader's choices.
  useEffect(() => {
    if (!tree || seeded.current) return;
    seeded.current = true;
    setExpanded(tree.defaultExpanded);
    setSelected(tree.items[0]?.id ?? null);
  }, [tree]);

  if (missing) {
    return (
      <EmptyState
        title="Session not found"
        description="It does not exist, or you are not a member of its project."
        action={<Link href="/sessions">Back to sessions</Link>}
      />
    );
  }
  if (!detail || !tree) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const s = detail.session;
  const origin = Date.parse(s.startedAt);
  const total = Math.max(1, s.durationMs);
  const info = selected ? tree.info.get(selected) : undefined;
  const node = info ? describeNode(info) : null;
  const span = info ? nodeSpan(info) : null;

  return (
    <>
      <div className="mb-4">
        <Link href="/sessions" className="text-sm text-ink-3 hover:underline">
          ← Sessions
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          {s.title ?? s.externalId}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <Badge tone="neutral" label={s.runtime} />
          {s.parsed ? null : <Badge tone="warn" label="not parsed" />}
          <span>{s.projectName ?? 'No project'}</span>
          {s.slotName ? <span>· slot {s.slotName}</span> : null}
          {s.gitBranch ? <span>· {s.gitBranch}</span> : null}
          <span>· {formatTime(s.startedAt)}</span>
          <span>· {formatDuration(s.durationMs)}</span>
        </div>
        <div className="mt-1 break-all text-xs text-ink-3">{s.cwd}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone="neutral" label={`${s.turns} turns`} />
          <Badge tone="neutral" label={`${detail.totals.requests} requests`} />
          <Badge tone="neutral" label={`${s.toolCalls} tool calls`} />
          <Badge tone="neutral" label={`${s.subagents} subagents`} />
          <Badge
            tone="neutral"
            label={`${formatTokens(tokenSum(detail.totals))} tokens`}
          />
          <Badge
            tone="neutral"
            label={`cost ${formatCost(detail.totals.costUsd)}`}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <Tree
            aria-label="Session tree"
            items={tree.items}
            expandedIds={expanded}
            onExpandedChange={setExpanded}
            selectedId={selected}
            onSelectedChange={setSelected}
          />
        </div>

        <div className="flex flex-col gap-4">
          {node ? (
            <>
              <h2 className="text-lg font-medium">{node.title}</h2>
              {span ? (
                <div className="flex flex-col gap-1">
                  <Bar span={span} origin={origin} total={total} />
                  <div className="text-xs text-ink-3">
                    {formatDuration(span[1] - span[0])} · starts{' '}
                    {formatDuration(span[0] - origin)} into the session
                  </div>
                </div>
              ) : null}
              {node.facts.length > 0 ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  {node.facts.map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-ink-3">{label}</dt>
                      <dd className="break-all">{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <TotalsTable totals={node.totals} />
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
