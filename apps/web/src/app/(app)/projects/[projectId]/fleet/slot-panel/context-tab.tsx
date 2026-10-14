'use client';

import type { SlotDetail } from '@agentdock/shared';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import type { ReactNode } from 'react';
import {
  formatRound,
  SLOT_TERM_HINT,
} from '../../../../../../lib/fleet/format';

function Term({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span>{label}</span>
      <span className="text-xs font-normal text-ink-3">{hint}</span>
    </span>
  );
}

function Globs({ globs }: { globs: string[] }): ReactNode {
  if (globs.length === 0) return '—';
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
    <KeyValueList
      items={[
        {
          key: 'brief',
          label: <Term label="Brief" hint={SLOT_TERM_HINT.brief} />,
          value: slot.round ? formatRound(slot.round) : '—',
        },
        {
          key: 'issue',
          label: 'Issue',
          value: slot.issue === null ? '—' : `#${slot.issue}`,
        },
        {
          key: 'model',
          label: 'Model',
          value: (
            <span className="flex flex-col gap-0.5">
              <span>
                {slot.model ?? 'model unknown'} · {slot.runtime}
              </span>
              {slot.modelWhy ? (
                <span className="text-ink-2">{slot.modelWhy}</span>
              ) : null}
            </span>
          ),
        },
        ...(slot.lead
          ? [
              {
                key: 'lead',
                label: <Term label="Lead" hint={SLOT_TERM_HINT.lead} />,
                value: 'yes',
              },
            ]
          : []),
        {
          key: 'branch',
          label: 'Branch',
          value: slot.branch ?? '—',
          copyValue: slot.branch ?? undefined,
        },
        {
          key: 'owns',
          label: <Term label="Owns" hint={SLOT_TERM_HINT.owns} />,
          value: <Globs globs={slot.owns} />,
        },
        {
          key: 'never',
          label: <Term label="Never" hint={SLOT_TERM_HINT.never} />,
          value: <Globs globs={slot.never} />,
        },
      ]}
    />
  );
}
