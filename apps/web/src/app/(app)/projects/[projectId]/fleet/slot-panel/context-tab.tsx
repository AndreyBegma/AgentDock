'use client';

import type { SlotDetail } from '@agentdock/shared';
import type { ReactNode } from 'react';
import {
  formatAheadBehind,
  formatRound,
  SLOT_TERM_HINT,
} from '../../../../../../lib/fleet/format';

/**
 * Label over value, not side by side: the fence's globs and the model's
 * reason are long, and a two-column list clips them in a narrow column.
 */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  /** One line that says what the term means. */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-ink-2">{label}</dt>
      {hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function Globs({ globs }: { globs: string[] }) {
  if (globs.length === 0) return <>—</>;
  return (
    <ul className="flex flex-col gap-1">
      {globs.map((glob) => (
        <li key={glob}>
          <code className="break-all font-mono text-xs">{glob}</code>
        </li>
      ))}
    </ul>
  );
}

/** The brief the orchestrator dispatched the slot with: model, reason, fence. */
export function ContextTab({ slot }: { slot: SlotDetail }) {
  return (
    <dl className="flex flex-col gap-4">
      <Row label="Brief" hint={SLOT_TERM_HINT.brief}>
        {slot.round ? formatRound(slot.round) : '—'}
        {slot.issue !== null ? ` · issue #${slot.issue}` : ''}
      </Row>
      <Row label="Model">
        {slot.model ?? 'model unknown'} · {slot.runtime}
        {slot.modelWhy ? (
          <span className="block text-ink-2">{slot.modelWhy}</span>
        ) : null}
      </Row>
      {slot.lead ? (
        <Row label="Lead" hint={SLOT_TERM_HINT.lead}>
          yes
        </Row>
      ) : null}
      <Row label="Branch">{slot.branch ?? '—'}</Row>
      <Row label="Worktree">
        <span className="break-all">{slot.worktree}</span>
        <span className="block text-xs text-ink-3">
          {slot.worktreeExists ? 'exists' : 'gone'}
          {slot.dirty ? ' · uncommitted changes' : ''} ·{' '}
          {formatAheadBehind(slot.ahead, slot.behind)}
        </span>
      </Row>
      <Row label="Owns" hint={SLOT_TERM_HINT.owns}>
        <Globs globs={slot.owns} />
      </Row>
      <Row label="Never" hint={SLOT_TERM_HINT.never}>
        <Globs globs={slot.never} />
      </Row>
    </dl>
  );
}
