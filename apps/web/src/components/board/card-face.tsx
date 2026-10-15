import type { BoardCardView } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { Paperclip } from 'lucide-react';
import NextLink from 'next/link';
import { attachmentCountLabel } from '../../lib/attachments/format';
import {
  approveRunOffer,
  autoRunReason,
  confidenceLabel,
  fleetHref,
  fleetSummary,
  HOOKS_GUIDE_LABEL,
  hooksGuideHref,
  hooksHint,
  isSessionAlive,
  isSuggestion,
  roundPill,
  SLOT_GONE_TEXT,
  sessionHref,
  TRACKED_TEXT,
  trackedSessionHref,
} from '../../lib/board/format';
import { prChipText } from '../../lib/board/pull-request';
import { formatCost } from '../../lib/format';
import { safeHttpsUrl } from '../../lib/queue/format';
import { ApproveRunLink, CardFaceDesign } from './card-design';

/** What a card shows on the board: label, title, kind, round state, PR and issue, cost. */
export function CardFace({
  projectId,
  card,
  canOperate,
  compact = false,
  onOpen,
}: {
  projectId: string;
  card: BoardCardView;
  canOperate: boolean;
  /** C-29 Compact density: the issue and PR links are left to the sheet. */
  compact?: boolean;
  onOpen: (card: BoardCardView) => void;
}) {
  const offer = approveRunOffer(card);
  const pill = roundPill(card.round);
  const cost = formatCost(card.costUsd);
  const prHref = card.prUrl ? safeHttpsUrl(card.prUrl) : null;
  const issueHref = card.issueUrl ? safeHttpsUrl(card.issueUrl) : null;
  return (
    <div
      className={`flex min-w-0 flex-col text-sm ${compact ? 'gap-1' : 'gap-1.5'}`}
    >
      <div className="flex items-center gap-2 text-xs text-ink-2">
        <span className="font-mono">{card.label}</span>
        {card.kind === 'bug' ? (
          <Chip size="sm" tone="danger">
            Bug
          </Chip>
        ) : null}
        {card.attachmentCount > 0 ? (
          <span
            className="flex items-center gap-0.5 tabular-nums"
            role="img"
            aria-label={attachmentCountLabel(card.attachmentCount)}
            title={attachmentCountLabel(card.attachmentCount)}
          >
            <Paperclip aria-hidden="true" className="size-3" />
            {card.attachmentCount}
          </span>
        ) : null}
        {cost ? <span className="ml-auto tabular-nums">{cost}</span> : null}
      </div>
      <button
        type="button"
        className="break-words text-left font-medium underline-offset-2 hover:underline"
        onClick={() => onOpen(card)}
      >
        {card.title}
      </button>
      <CardFaceDesign card={card} />
      {card.tracking ? <TerminalFace card={card} /> : null}
      {card.fleet ? <FleetFace projectId={projectId} card={card} /> : null}
      {card.autoRunFailure ? (
        <div>
          <Tooltip content={autoRunReason(card.autoRunFailure)}>
            <span>
              <Badge tone="warn" size="md" label="Didn’t start" />
            </span>
          </Tooltip>
        </div>
      ) : null}
      {offer && canOperate ? (
        <div>
          <ApproveRunLink
            projectId={projectId}
            card={card}
            offer={offer}
            variant="glass"
            size="sm"
          />
          {offer.reason ? (
            <p className="mt-1 text-xs text-ink-3">{offer.reason}</p>
          ) : null}
        </div>
      ) : null}
      {isSuggestion(card) ? <SuggestionFace card={card} /> : null}
      {pill || card.round?.hooksMissing ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {pill ? (
            <StatusPill size="sm" status={pill.status} label={pill.label} />
          ) : null}
          {card.round?.hooksMissing ? (
            <Tooltip content={hooksHint}>
              <NextLink
                href={hooksGuideHref(projectId)}
                aria-label={`hooks not set up. ${HOOKS_GUIDE_LABEL}`}
              >
                <Chip size="sm">hooks not set up</Chip>
              </NextLink>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      {!compact && (card.prNumber !== null || card.issueNumber !== null) ? (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {card.prNumber !== null ? (
            <Link href={prHref}>{prChipText(card)}</Link>
          ) : null}
          {card.issueNumber !== null ? (
            <Link href={issueHref}>Issue #{card.issueNumber}</Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** #282 D1: a card tracked from a terminal session: the badge, the state, the session link. */
function TerminalFace({ card }: { card: BoardCardView }) {
  const session = trackedSessionHref(card);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Tooltip content={TRACKED_TEXT}>
        <span>
          <Badge tone="neutral" size="sm" label="Terminal" />
        </span>
      </Tooltip>
      {isSessionAlive(card) ? (
        <StatusPill size="sm" status="running" label="Session running" />
      ) : null}
      {card.autoCollect ? <Chip size="sm">Automatic work</Chip> : null}
      {session ? (
        <NextLink
          href={session}
          className="text-xs text-accent-ink underline-offset-2 hover:underline"
        >
          Session
        </NextLink>
      ) : null}
    </div>
  );
}

/** #282 D4: a mirrored fleet slot: the badge, slot and stage, "Slot gone", the Fleet link. */
function FleetFace({
  projectId,
  card,
}: {
  projectId: string;
  card: BoardCardView;
}) {
  const fleet = card.fleet;
  if (!fleet) return null;
  const href = fleetHref(projectId, card);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral" size="sm" label="Fleet" />
        {fleet.slotGone ? (
          <Tooltip content="The slot left the fleet; the card keeps its last column.">
            <span>
              <Badge tone="warn" size="sm" label={SLOT_GONE_TEXT} />
            </span>
          </Tooltip>
        ) : null}
      </div>
      <p className="break-words text-xs text-ink-2">{fleetSummary(fleet)}</p>
      {href ? (
        <NextLink
          href={href}
          className="text-xs text-accent-ink underline-offset-2 hover:underline"
        >
          Open in Fleet
        </NextLink>
      ) : null}
    </div>
  );
}

/** #244: what an Inbox card adds — the why, the confidence and the session it came from. */
function SuggestionFace({ card }: { card: BoardCardView }) {
  const confidence = confidenceLabel(card.captureConfidence);
  const session = sessionHref(card.sourceSessionId);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="warn" size="sm" label="Suggested" />
        {confidence ? (
          <span className="text-xs tabular-nums text-ink-2">
            {confidence} sure
          </span>
        ) : null}
      </div>
      {card.captureWhy ? (
        <p className="break-words text-xs text-ink-2">{card.captureWhy}</p>
      ) : null}
      {session ? (
        <NextLink
          href={session}
          className="text-xs text-accent-ink underline-offset-2 hover:underline"
        >
          Source session
        </NextLink>
      ) : null}
    </div>
  );
}

function Link({
  href,
  children,
}: {
  href: string | null;
  children: React.ReactNode;
}) {
  if (!href) return <Chip size="sm">{children}</Chip>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-full bg-hover px-2 py-0.5 text-ink-2 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}
