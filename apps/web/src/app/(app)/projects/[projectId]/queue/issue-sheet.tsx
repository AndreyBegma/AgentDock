'use client';

import type { QueueIssueDetail } from '@agentdock/shared';
import { SheetContent, SheetRoot } from 'glass-ui/sheet';
import { Skeleton } from 'glass-ui/skeleton';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import {
  blockerLabel,
  describeQueueError,
  priorityLabel,
  safeHttpsUrl,
  stateLabel,
} from '../../../../../lib/queue/format';
import { ComputedNote, StateBadge } from './state-cells';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-ink-2">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function Detail({ issue }: { issue: QueueIssueDetail }) {
  const href = safeHttpsUrl(issue.url);
  return (
    <dl className="flex flex-col gap-4">
      <Row label="State">
        <span className="flex flex-col items-start gap-1">
          <StateBadge item={issue} />
          <ComputedNote item={issue} />
        </span>
      </Row>
      <Row label="Why">{issue.why || '—'}</Row>
      {issue.clears ? (
        <Row label="What would clear it">{issue.clears}</Row>
      ) : null}
      <Row label="Priority">{priorityLabel(issue.priority)}</Row>
      <Row label="Depends on">
        {issue.blockers.length === 0 ? (
          '—'
        ) : (
          <ul className="flex flex-col gap-1">
            {issue.blockers.map((blocker) => {
              const link = safeHttpsUrl(blocker.url);
              return (
                <li key={blocker.number}>
                  {link ? (
                    <a
                      href={link}
                      target="_blank"
                      rel="noreferrer"
                      className="underline-offset-2 hover:underline"
                    >
                      {blockerLabel(blocker)}
                    </a>
                  ) : (
                    blockerLabel(blocker)
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Row>
      {issue.waveSlots ? (
        <Row label="Parallel plan">
          {issue.waveSlots.length === 0 ? (
            '—'
          ) : (
            <ul className="flex flex-col gap-1">
              {issue.waveSlots.map((slot) => (
                <li key={slot.slot}>
                  {slot.slot}
                  {slot.lead ? ' · lead' : ''}
                  {slot.model ? ` · ${slot.model}` : ''}
                </li>
              ))}
            </ul>
          )}
        </Row>
      ) : null}
      <Row label="Labels">{issue.labels.join(', ') || '—'}</Row>
      <Row label="Verdicts in the latest rounds">
        {issue.history.length === 0 ? (
          'None recorded.'
        ) : (
          <ol className="flex flex-col gap-2">
            {issue.history.map((entry) => (
              <li
                key={`${entry.date}/${entry.round}`}
                className="flex flex-col"
              >
                <span>
                  {entry.date} {entry.round} · {stateLabel(entry.state)}
                </span>
                {entry.why ? (
                  <span className="text-xs text-ink-2">{entry.why}</span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Row>
      <Row label="Body">
        {issue.body ? (
          <pre className="whitespace-pre-wrap rounded-control bg-surface p-3 font-mono text-xs">
            {issue.body}
          </pre>
        ) : (
          '—'
        )}
      </Row>
      {href ? (
        <Row label="On GitHub">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {href}
          </a>
        </Row>
      ) : null}
    </dl>
  );
}

/** The latest detail for issue `number`, refetched when `version` changes (a live push). */
export function IssueSheet({
  projectId,
  number,
  title,
  version,
  onClose,
}: {
  projectId: string;
  number: number | undefined;
  title: string | undefined;
  version: number;
  onClose: () => void;
}) {
  const [issue, setIssue] = useState<QueueIssueDetail>();
  const [error, setError] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is a refetch trigger
  useEffect(() => {
    if (number === undefined) return;
    let cancelled = false;
    api<QueueIssueDetail>(`/projects/${projectId}/queue/${number}`)
      .then((detail) => {
        if (cancelled) return;
        setIssue(detail);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeQueueError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, number, version]);

  const close = () => {
    setIssue(undefined);
    setError(undefined);
    onClose();
  };

  return (
    <SheetRoot
      open={number !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {number !== undefined ? (
        <SheetContent
          side="right"
          title={`#${number} ${title ?? ''}`.trim()}
          description="Queue issue"
        >
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : issue && issue.number === number ? (
            <Detail issue={issue} />
          ) : (
            <Skeleton className="h-64 w-full" />
          )}
        </SheetContent>
      ) : null}
    </SheetRoot>
  );
}
