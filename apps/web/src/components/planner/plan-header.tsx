'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import type { PlanDetail } from '@nautelle/shared';
import { Globe, Lock } from 'lucide-react';
import NextLink from 'next/link';
import { boardHref } from '../../lib/board/href';
import { Time } from '../../lib/format/time';
import {
  canRevise,
  planPill,
  SEND_BLOCK_TEXT,
  sendBlock,
} from '../../lib/planner/format';
import { briefBeyondTitle, createCardsBlock } from '../../lib/planner/header';
import { plannerHref } from '../../lib/planner/href';
import { useTextNotes } from '../../lib/text/use-text-notes';
import { githubUrl } from '../../lib/url';
import { PageHeader } from '../page-header/page-header';
import { NormalizedNote } from '../text/normalized-note';

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
 * The plan's header (spec 172 UI, #213): title, version, the derived status
 * (a failed newest turn reads Failed, not Drafting), visibility with **Share
 * with project**, **Approve all drafts (n)**, **Revise plan** when a rewrite
 * is pending, and **Send to fleet** — the screen's one solid — when D8
 * allows; the reason sits in a tooltip when it does not. One button size.
 * The brief is the description only where it says more than the title.
 */
export function PlanHeader({
  plan,
  projectId,
  isAuthor,
  canWrite,
  busy,
  approveCount,
  onShare,
  onApproveAll,
  onRevise,
  onSend,
  onArchive,
  onCreateCards = null,
  readOnly = false,
}: {
  plan: PlanDetail;
  projectId: string;
  isAuthor: boolean;
  /** Operator, plan open. */
  canWrite: boolean;
  busy: boolean;
  /** Drafts **Approve all drafts** would approve. */
  approveCount: number;
  onShare: () => void;
  onApproveAll: () => void;
  onRevise: () => void;
  onSend: () => void;
  onArchive: (() => void) | null;
  /**
   * #337 D7: **Create cards**, on the Board's plan panel. It is then the
   * one solid action and Send to fleet the alternative beside it.
   */
  onCreateCards?: (() => void) | null;
  /**
   * #337 D11: the retired Planner page — the plan is read, not worked: only
   * Archive (closing an old plan ends its Board projection) stays.
   */
  readOnly?: boolean;
}) {
  const block = sendBlock(plan);
  const cardsBlock = createCardsBlock(plan);
  const idle = plan.activeTurnId === null;
  const revisable = canRevise(plan) && idle;
  const closed =
    plan.status === 'sent' ||
    plan.status === 'archived' ||
    plan.status === 'done';
  const pill = planPill(plan);
  const brief = briefBeyondTitle(plan);
  // The retired page says why it is read-only where the header can be read.
  const description = readOnly
    ? `Read-only: the Planner moved onto the Board.${brief ? ` ${brief}` : ''}`
    : brief;
  const notes = useTextNotes(projectId, { planId: plan.id }, plan.version);
  const briefNote = notes.view('plan', plan.id, 'brief');
  // The docs PR link is followed only when it really is GitHub.
  const docsPrHref = githubUrl(plan.docsPrUrl);

  return (
    <PageHeader
      className="mb-0"
      link={NextLink}
      primaryAction={
        readOnly && !closed
          ? { label: 'Open the Board', href: boardHref(projectId) }
          : undefined
      }
      overflow={
        readOnly && !closed && onArchive
          ? [
              {
                id: 'archive',
                label: 'Archive plan',
                tone: 'danger',
                disabled: busy,
                onSelect: onArchive,
              },
            ]
          : undefined
      }
      eyebrow={
        <span className="flex flex-wrap items-center gap-2">
          {/* The breadcrumbs lead back on a desktop; a phone has none. */}
          <NextLink
            href={plannerHref(projectId)}
            className="text-accent-ink underline underline-offset-2 lg:hidden"
          >
            Planner
          </NextLink>
          <span aria-hidden="true" className="lg:hidden">
            /
          </span>
          <span>
            Version {plan.version} · {plan.author.name} · updated{' '}
            <Time value={plan.updatedAt} />
          </span>
        </span>
      }
      title={
        <>
          <span className="min-w-0 break-words">{plan.title}</span>
          <StatusPill status={pill.status} label={pill.label} />
          <VisibilityChip plan={plan} />
        </>
      }
      description={
        description || briefNote ? (
          <>
            {description ? (
              <span className="line-clamp-2 whitespace-pre-line">
                {description}
              </span>
            ) : null}
            <NormalizedNote
              view={briefNote}
              canOperate={canWrite}
              onRetry={notes.retry}
            />
          </>
        ) : undefined
      }
      actions={
        closed ? (
          docsPrHref ? (
            <a
              href={docsPrHref}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm text-accent-ink underline underline-offset-2"
            >
              Docs pull request{' '}
              {plan.docsPrRepo
                ? `${plan.docsPrRepo}#${plan.docsPrNumber}`
                : `#${plan.docsPrNumber}`}
            </a>
          ) : undefined
        ) : readOnly ? undefined : (
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
            {canWrite && approveCount > 0 ? (
              <Button
                variant="glass"
                disabled={busy || !idle}
                onClick={onApproveAll}
              >
                Approve all drafts ({approveCount})
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
                    <Button
                      variant={onCreateCards ? 'glass' : undefined}
                      disabled={busy || block !== null}
                      onClick={onSend}
                    >
                      Send to fleet
                    </Button>
                  </span>
                </Tooltip>
                {onCreateCards ? (
                  <Tooltip
                    content={
                      cardsBlock ??
                      'One Todo card per task, with Depends on links like the graph.'
                    }
                  >
                    <span>
                      <Button
                        disabled={busy || cardsBlock !== null}
                        onClick={onCreateCards}
                      >
                        Create cards
                      </Button>
                    </span>
                  </Tooltip>
                ) : null}
              </>
            ) : null}
          </>
        )
      }
    />
  );
}
