'use client';

import { Chip } from '@andrewbehma/glass-ui/chip';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import type { AssistantToolStep } from '@nautelle/shared';
import { Check, X } from 'lucide-react';
import Link from 'next/link';
import { cardLabelOf } from '../../lib/assistant/tools';
import type { LiveTool } from '../../lib/assistant/turn';
import { approvalsHref } from '../../lib/queue/tabs';

const RUNNING_LABEL: Record<string, string> = {
  draft_card: 'Drafting a card',
  queue_card: 'Queueing a card',
  request_action: 'Asking for approval',
};

const runningLabel = (name: string) =>
  RUNNING_LABEL[name] ??
  `${name.startsWith('read_') ? 'Reading' : 'Working'} — ${name.replaceAll('_', ' ')}`;

/** One tool step of a reply: a row, or a richer block for a card and an approval. */
export function ToolBlock({
  tool,
  projectId,
}: {
  tool: LiveTool | (AssistantToolStep & { status?: 'done' });
  /** The conversation's project, once resolved: where a card link points. */
  projectId: string | null;
}) {
  if (tool.status === 'running') {
    return (
      <div className="flex items-center gap-2 text-xs text-ink-3">
        <Spinner size="sm" label={null} />
        <span>{runningLabel(tool.name)}…</span>
      </div>
    );
  }
  const step = tool;
  const label = step.name === 'queue_card' ? cardLabelOf(step.summary) : null;
  const cardProject = step.draft?.projectId ?? projectId;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
      {step.ok ? (
        <Check size={14} aria-hidden="true" className="text-ok" />
      ) : (
        <X size={14} aria-hidden="true" className="text-danger" />
      )}
      <span className={step.ok ? undefined : 'text-danger'}>
        {step.summary}
      </span>
      {step.name === 'draft_card' && step.ok ? (
        <Chip tone="neutral">Draft</Chip>
      ) : null}
      {label && step.ok && cardProject ? (
        <Link
          href={`/projects/${encodeURIComponent(cardProject)}/board/cards/${label.number}`}
          className="text-accent-ink underline"
        >
          Open {label.label}
        </Link>
      ) : null}
      {step.name === 'request_action' && step.ok ? (
        <>
          <Chip tone="warn">Waiting for approval</Chip>
          {cardProject ? (
            <Link
              href={approvalsHref(encodeURIComponent(cardProject))}
              className="text-accent-ink underline"
            >
              Open Approvals
            </Link>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
