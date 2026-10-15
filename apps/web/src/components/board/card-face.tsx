import type { BoardCardView } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import NextLink from 'next/link';
import {
  approveRunOffer,
  autoRunReason,
  confidenceLabel,
  hooksHint,
  isSuggestion,
  roundPill,
  sessionHref,
} from '../../lib/board/format';
import { formatCost } from '../../lib/format';
import { safeHttpsUrl } from '../../lib/queue/format';
import { ApproveRunLink, CardFaceDesign } from './card-design';

/** What a card shows on the board: label, title, kind, round state, PR and issue, cost. */
export function CardFace({
  projectId,
  card,
  canOperate,
  onOpen,
}: {
  projectId: string;
  card: BoardCardView;
  canOperate: boolean;
  onOpen: (card: BoardCardView) => void;
}) {
  const offer = approveRunOffer(card);
  const pill = roundPill(card.round);
  const cost = formatCost(card.costUsd);
  const prHref = card.prUrl ? safeHttpsUrl(card.prUrl) : null;
  const issueHref = card.issueUrl ? safeHttpsUrl(card.issueUrl) : null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm">
      <div className="flex items-center gap-2 text-xs text-ink-2">
        <span className="font-mono">{card.label}</span>
        {card.kind === 'bug' ? (
          <Chip size="sm" tone="danger">
            Bug
          </Chip>
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
              <span>
                <Chip size="sm">hooks not installed</Chip>
              </span>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      {card.prNumber !== null || card.issueNumber !== null ? (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {card.prNumber !== null ? (
            <Link href={prHref}>PR #{card.prNumber}</Link>
          ) : null}
          {card.issueNumber !== null ? (
            <Link href={issueHref}>Issue #{card.issueNumber}</Link>
          ) : null}
        </div>
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
