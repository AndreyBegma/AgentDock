'use client';

import {
  APPROVALS_LIVE_EVENT,
  type ApprovalItemView,
  type ApprovalsView,
  type ProjectDetail,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { EmptyState } from 'glass-ui/empty-state';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { Tooltip } from 'glass-ui/tooltip';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../../../lib/api';
import {
  deciderLabel,
  describeApprovalError,
  isNotFound,
  mismatchSentence,
  SOURCE_LABEL,
  SOURCE_TOOLTIP,
  STATUS_LABEL,
  STATUS_TONE,
} from '../../../../../lib/approvals/format';
import {
  CHECKS_LABEL,
  CHECKS_TONE,
  formatAgo,
} from '../../../../../lib/fleet/format';
import { useLive, useLiveStatus } from '../../../../../lib/live/use-live';
import { safeHttpsUrl } from '../../../../../lib/queue/format';
import { ApprovalSheet } from './approval-sheet';

/** Pushes arrive in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;
/** "Waiting 3 min" is relative to now. */
const AGE_TICK_MS = 30_000;

function PrLink({ item }: { item: ApprovalItemView }) {
  const href = safeHttpsUrl(item.url);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline-offset-2 hover:underline"
    >
      #{item.pr}
    </a>
  ) : (
    <>#{item.pr}</>
  );
}

function SourceBadge({ item }: { item: ApprovalItemView }) {
  return (
    <Tooltip content={SOURCE_TOOLTIP[item.source]}>
      <span className="inline-flex">
        <Badge
          tone={item.source === 'derived' ? 'neutral' : 'ok'}
          label={SOURCE_LABEL[item.source]}
        />
      </span>
    </Tooltip>
  );
}

function ChecksCell({ item }: { item: ApprovalItemView }) {
  if (!item.checks) return <>—</>;
  const label = CHECKS_LABEL[item.checks];
  return (
    <span className="inline-flex items-center gap-2">
      <Badge dot tone={CHECKS_TONE[item.checks]} aria-hidden="true" />
      {label}
    </span>
  );
}

function ActionCell({
  item,
  onSelect,
}: {
  item: ApprovalItemView;
  onSelect: (item: ApprovalItemView) => void;
}) {
  return (
    <div className="flex justify-end">
      <Button
        variant="glass"
        size="sm"
        aria-label={`Details for pull request ${item.pr}`}
        onClick={() => onSelect(item)}
      >
        Details
      </Button>
    </div>
  );
}

export default function ApprovalsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [view, setView] = useState<ApprovalsView>();
  const [role, setRole] = useState<ProjectDetail['role']>();
  const [missing, setMissing] = useState(false);
  /** Bumped by a live push; every fetch effect depends on it. */
  const [version, setVersion] = useState(0);
  const [, setNow] = useState(0);
  const [selected, setSelected] = useState<ApprovalItemView>();

  const live = useLiveStatus();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLive(`project:${projectId}`, (message) => {
    if (message.event !== APPROVALS_LIVE_EVENT) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // The role gates the buttons; the API stays the authority (403 on a viewer).
  useEffect(() => {
    let cancelled = false;
    api<ProjectDetail>(`/projects/${projectId}`)
      .then((project) => {
        if (!cancelled) setRole(project.role);
      })
      .catch(() => {
        if (!cancelled) setRole('viewer');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is a refetch trigger
  useEffect(() => {
    let cancelled = false;
    api<ApprovalsView>(`/projects/${projectId}/approvals`)
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setMissing(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isNotFound(err)) setMissing(true);
        else toast.error(describeApprovalError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  if (missing) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
      />
    );
  }
  if (!view) return <Skeleton className="h-64 w-full" />;

  const canOperate = role !== undefined && role !== 'viewer';
  const mismatch = mismatchSentence(view.mergeApproval, view.configMismatch);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Approvals</h1>
          <p className="text-sm text-ink-2">
            Pull requests that wait for a person before the orchestrator merges
            them. AgentDock never merges itself.
          </p>
        </div>
        <span className="inline-flex items-center gap-2 text-xs text-ink-2">
          <Badge
            dot
            tone={live.status === 'connected' ? 'ok' : 'warn'}
            aria-hidden="true"
          />
          {live.status === 'connected'
            ? 'Live'
            : live.status === 'reconnecting'
              ? 'Reconnecting…'
              : 'Offline'}
        </span>
      </div>

      {mismatch ? (
        <Banner tone="warn" title="Merge approval settings disagree">
          {mismatch}
        </Banner>
      ) : null}

      {view.waiting.length === 0 ? (
        <EmptyState
          title="Nothing is waiting"
          description="No pull request waits for approval right now. New ones appear here by themselves."
        />
      ) : (
        <Table scroll>
          <TableHead>
            <TableRow>
              <TableCell head>PR</TableCell>
              <TableCell head>Title</TableCell>
              <TableCell head>Slot</TableCell>
              <TableCell head>Checks</TableCell>
              <TableCell head>Waiting</TableCell>
              <TableCell head>Source</TableCell>
              <TableCell head>
                <span className="sr-only">Details</span>
              </TableCell>
            </TableRow>
          </TableHead>
          <tbody>
            {view.waiting.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <PrLink item={item} />
                </TableCell>
                <TableCell>
                  <span className="font-medium">{item.title ?? '—'}</span>
                  {item.issue !== null ? (
                    <span className="block text-xs text-ink-3">
                      issue #{item.issue}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>{item.slot ?? '—'}</TableCell>
                <TableCell>
                  <ChecksCell item={item} />
                </TableCell>
                <TableCell>{formatAgo(item.waitingSince)}</TableCell>
                <TableCell>
                  <SourceBadge item={item} />
                </TableCell>
                <TableCell>
                  <ActionCell item={item} onSelect={setSelected} />
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Recent decisions</h2>
        {view.recent.length === 0 ? (
          <p className="text-sm text-ink-2">No decision yet.</p>
        ) : (
          <Table scroll>
            <TableHead>
              <TableRow>
                <TableCell head>PR</TableCell>
                <TableCell head>Decision</TableCell>
                <TableCell head>By</TableCell>
                <TableCell head>When</TableCell>
                <TableCell head>Note</TableCell>
                <TableCell head>
                  <span className="sr-only">Details</span>
                </TableCell>
              </TableRow>
            </TableHead>
            <tbody>
              {view.recent.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <PrLink item={item} />
                    {item.title ? (
                      <span className="block text-xs text-ink-3">
                        {item.title}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge
                      tone={STATUS_TONE[item.status]}
                      label={STATUS_LABEL[item.status]}
                    />
                  </TableCell>
                  <TableCell>{deciderLabel(item)}</TableCell>
                  <TableCell>
                    {formatAgo(item.decidedAt ?? item.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <span className="line-clamp-2 break-words">
                      {item.note ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ActionCell item={item} onSelect={setSelected} />
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <ApprovalSheet
        projectId={projectId}
        pr={selected?.pr}
        title={selected?.title}
        canOperate={canOperate}
        version={version}
        onClose={() => setSelected(undefined)}
        onChanged={() => setVersion((v) => v + 1)}
      />
    </div>
  );
}
