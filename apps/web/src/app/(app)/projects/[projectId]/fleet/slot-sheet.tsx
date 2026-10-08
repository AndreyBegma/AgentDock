'use client';

import type { SlotDetail } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { SheetContent, SheetRoot } from 'glass-ui/sheet';
import { Skeleton } from 'glass-ui/skeleton';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import {
  CHECKPOINT_TONE,
  CHECKS_LABEL,
  CHECKS_TONE,
  describeFleetError,
  formatAgo,
  formatAheadBehind,
  formatRound,
  SLOT_STATUS_LABEL,
  SLOT_STATUS_TONE,
  safeHttpsUrl,
} from '../../../../../lib/fleet/format';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-ink-2">{label}</dt>
      <dd className="break-all text-sm">{children}</dd>
    </div>
  );
}

function Globs({ globs }: { globs: string[] }) {
  if (globs.length === 0) return <>—</>;
  return (
    <ul className="flex flex-col gap-1">
      {globs.map((glob) => (
        <li key={glob}>
          <code className="font-mono text-xs">{glob}</code>
        </li>
      ))}
    </ul>
  );
}

function Detail({ slot }: { slot: SlotDetail }) {
  const prHref = safeHttpsUrl(slot.prUrl);
  return (
    <dl className="flex flex-col gap-4">
      <Row label="Status">
        <Badge
          tone={SLOT_STATUS_TONE[slot.status]}
          label={SLOT_STATUS_LABEL[slot.status]}
        />
      </Row>
      <Row label="Brief">
        {slot.round ? formatRound(slot.round) : '—'} · {slot.runtime} ·{' '}
        {slot.model ?? 'model unknown'}
        {slot.lead ? ' · lead' : ''}
        {slot.modelWhy ? (
          <span className="block text-ink-2">{slot.modelWhy}</span>
        ) : null}
      </Row>
      <Row label="Branch">{slot.branch ?? '—'}</Row>
      <Row label="Worktree">
        {slot.worktree}
        <span className="block text-xs text-ink-3">
          {slot.worktreeExists ? 'exists' : 'gone'}
          {slot.dirty ? ' · uncommitted changes' : ''} ·{' '}
          {formatAheadBehind(slot.ahead, slot.behind)}
        </span>
      </Row>
      <Row label="Pull request">
        {slot.prNumber === null ? (
          '—'
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2">
            {prHref ? (
              <a
                href={prHref}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                #{slot.prNumber}
              </a>
            ) : (
              <>#{slot.prNumber}</>
            )}
            {slot.prState ? <span>{slot.prState}</span> : null}
            {slot.prChecks ? (
              <Badge
                tone={CHECKS_TONE[slot.prChecks]}
                label={CHECKS_LABEL[slot.prChecks]}
              />
            ) : null}
            {slot.prMergeable === null ? null : (
              <span>{slot.prMergeable ? 'mergeable' : 'conflicts'}</span>
            )}
          </span>
        )}
      </Row>
      <Row label="Owns">
        <Globs globs={slot.owns} />
      </Row>
      <Row label="Never">
        <Globs globs={slot.never} />
      </Row>
      <Row label="Checkpoints">
        {slot.checkpoints.length === 0 ? (
          'None yet.'
        ) : (
          <ol className="flex flex-col gap-3">
            {slot.checkpoints.map((checkpoint) => (
              <li key={checkpoint.id} className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={CHECKPOINT_TONE[checkpoint.kind]}
                    label={checkpoint.heading}
                  />
                  <span className="text-xs text-ink-3">
                    {formatAgo(checkpoint.at)}
                  </span>
                </span>
                {checkpoint.summary ? (
                  <pre className="whitespace-pre-wrap rounded-control bg-surface p-3 font-mono text-xs">
                    {checkpoint.summary}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Row>
    </dl>
  );
}

/** The latest slot by `name`, refetched when `version` changes (a live push). */
export function SlotSheet({
  projectId,
  name,
  version,
  onClose,
}: {
  projectId: string;
  name: string | undefined;
  version: number;
  onClose: () => void;
}) {
  const [slot, setSlot] = useState<SlotDetail>();
  const [error, setError] = useState<string>();

  // `version` only re-runs the fetch; the sheet keeps showing the old data meanwhile.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is a refetch trigger
  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    api<SlotDetail>(`/projects/${projectId}/slots/${encodeURIComponent(name)}`)
      .then((detail) => {
        if (cancelled) return;
        setSlot(detail);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeFleetError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, name, version]);

  const close = () => {
    setSlot(undefined);
    setError(undefined);
    onClose();
  };

  return (
    <SheetRoot
      open={name !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {name ? (
        <SheetContent
          side="right"
          title={name}
          description={slot?.issue ? `Issue #${slot.issue}` : 'Slot'}
        >
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : slot && slot.name === name ? (
            <Detail slot={slot} />
          ) : (
            <Skeleton className="h-64 w-full" />
          )}
        </SheetContent>
      ) : null}
    </SheetRoot>
  );
}
