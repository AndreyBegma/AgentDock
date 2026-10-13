'use client';

import type { PlanDetail } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { Globe, Lock } from 'lucide-react';
import Link from 'next/link';
import { Time } from '../../lib/format/time';
import {
  canRevise,
  PLAN_STATUS_LABEL,
  PLAN_STATUS_PILL,
  SEND_BLOCK_TEXT,
  sendBlock,
} from '../../lib/planner/format';
import { plannerHref } from '../../lib/planner/href';
import { PageHeader } from '../page-header/page-header';

export function VisibilityChip({
  plan,
}: {
  plan: Pick<PlanDetail, 'visibility'>;
}) {
  return plan.visibility === 'private' ? (
    <Chip size="sm" className="inline-flex items-center gap-1">
      <Lock aria-hidden="true" className="size-3" />
      Private
    </Chip>
  ) : (
    <Chip size="sm" className="inline-flex items-center gap-1">
      <Globe aria-hidden="true" className="size-3" />
      Project
    </Chip>
  );
}

/**
 * The plan's header (spec 172 UI): title, version, visibility with **Share
 * with project**, **Revise plan** when a rewrite is pending, and **Send to
 * fleet** when D8 allows; the reason sits in a tooltip when it does not.
 */
export function PlanHeader({
  plan,
  projectId,
  isAuthor,
  canWrite,
  busy,
  onShare,
  onRevise,
  onSend,
  onArchive,
}: {
  plan: PlanDetail;
  projectId: string;
  isAuthor: boolean;
  /** Operator, plan open. */
  canWrite: boolean;
  busy: boolean;
  onShare: () => void;
  onRevise: () => void;
  onSend: () => void;
  onArchive: (() => void) | null;
}) {
  const block = sendBlock(plan);
  const revisable = canRevise(plan) && plan.activeTurnId === null;
  const closed = plan.status === 'sent' || plan.status === 'archived';

  return (
    <PageHeader
      className="mb-0"
      eyebrow={
        <span className="flex flex-wrap items-center gap-2">
          <Link
            href={plannerHref(projectId)}
            className="text-accent-ink underline underline-offset-2"
          >
            Planner
          </Link>
          <span aria-hidden="true">/</span>
          <span>
            Version {plan.version} · {plan.author.name} · updated{' '}
            <Time value={plan.updatedAt} />
          </span>
        </span>
      }
      title={
        <>
          <span className="min-w-0 break-words">{plan.title}</span>
          <StatusPill
            status={PLAN_STATUS_PILL[plan.status]}
            label={PLAN_STATUS_LABEL[plan.status]}
          />
          <VisibilityChip plan={plan} />
        </>
      }
      description={
        <span className="line-clamp-2 whitespace-pre-line">{plan.brief}</span>
      }
      actions={
        closed ? (
          plan.docsPrUrl ? (
            <a
              href={plan.docsPrUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm text-accent-ink underline underline-offset-2"
            >
              Docs pull request #{plan.docsPrNumber}
            </a>
          ) : undefined
        ) : (
          <>
            {isAuthor && plan.visibility === 'private' ? (
              <Button variant="glass" disabled={busy} onClick={onShare}>
                Share with project
              </Button>
            ) : null}
            {onArchive ? (
              <Button variant="ghost" disabled={busy} onClick={onArchive}>
                Archive
              </Button>
            ) : null}
            {canWrite ? (
              <>
                <Tooltip
                  content={
                    revisable
                      ? 'Sends every rewrite comment in one pass.'
                      : 'Ask for a rewrite on a task first.'
                  }
                >
                  <span>
                    <Button
                      variant="glass"
                      disabled={busy || !revisable}
                      onClick={onRevise}
                    >
                      Revise plan
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip
                  content={
                    block
                      ? SEND_BLOCK_TEXT[block]
                      : 'Create the issues and queue them.'
                  }
                >
                  <span>
                    <Button disabled={busy || block !== null} onClick={onSend}>
                      Send to fleet
                    </Button>
                  </span>
                </Tooltip>
              </>
            ) : null}
          </>
        )
      }
    />
  );
}
