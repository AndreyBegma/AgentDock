'use client';

import type { SlotDetail } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { SheetContent, SheetRoot } from 'glass-ui/sheet';
import { Skeleton } from 'glass-ui/skeleton';
import { Tabs, TabsItem } from 'glass-ui/tabs';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import type { useControl } from '../../../../../lib/control/use-control';
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
import { PanePanel } from './pane-panel';
import { SlotControls } from './slot-controls';

const SHEET_TABS = [
  { id: 'detail', label: 'Details' },
  { id: 'pane', label: 'Pane' },
] as const;
type SheetTab = (typeof SHEET_TABS)[number]['id'];

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
  control,
  canOperate,
  onClose,
}: {
  projectId: string;
  name: string | undefined;
  version: number;
  control: ReturnType<typeof useControl>;
  /** Operators and above; the API decides regardless. */
  canOperate: boolean;
  onClose: () => void;
}) {
  const [slot, setSlot] = useState<SlotDetail>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<SheetTab>('detail');

  // A different slot opens on its details, not on the previous slot's pane.
  // biome-ignore lint/correctness/useExhaustiveDependencies: name is the reset trigger
  useEffect(() => {
    setTab('detail');
  }, [name]);

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
            <div className="flex flex-col gap-6">
              <Tabs aria-label="Slot sections">
                {SHEET_TABS.map(({ id, label }) => (
                  <TabsItem
                    key={id}
                    current={tab === id}
                    layoutId="slot-sheet-tab"
                  >
                    <button
                      type="button"
                      onClick={() => setTab(id)}
                      aria-pressed={tab === id}
                      className="relative flex w-full items-center justify-center px-3 py-2 text-sm font-medium"
                    >
                      {label}
                    </button>
                  </TabsItem>
                ))}
              </Tabs>
              {tab === 'pane' ? (
                <PanePanel projectId={projectId} slot={slot.name} />
              ) : (
                <>
                  <Detail slot={slot} />
                  {canOperate ? (
                    <SlotControls slot={slot.name} control={control} />
                  ) : null}
                </>
              )}
            </div>
          ) : (
            <Skeleton className="h-64 w-full" />
          )}
        </SheetContent>
      ) : null}
    </SheetRoot>
  );
}
