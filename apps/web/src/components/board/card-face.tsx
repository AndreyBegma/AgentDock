import type { BoardCardView, CardRoundBrief } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import {
  Check,
  Clock,
  GitMerge,
  Layers,
  Paperclip,
  Sparkles,
  Zap,
} from 'lucide-react';
import NextLink from 'next/link';
import type { ReactNode } from 'react';
import { attachmentCountLabel } from '../../lib/attachments/format';
import { dependencyChip, readinessChip } from '../../lib/board/dependencies';
import {
  approveRunOffer,
  autoRunFailureText,
  blockingDialogText,
  collectFailedBadge,
  confidenceLabel,
  finishRefusedText,
  fleetHref,
  fleetSummary,
  HOOKS_GUIDE_LABEL,
  hooksGuideHref,
  hooksNotice,
  isSessionAlive,
  isSuggestion,
  roundPill,
  SLOT_GONE_TEXT,
  sessionHref,
  TRACKED_TEXT,
  trackedSessionHref,
} from '../../lib/board/format';
import { prChipText } from '../../lib/board/pull-request';
import { ciDot, shippingBadge } from '../../lib/board/shipping';
import { hintsLabel } from '../../lib/board-ai/triage';
import { formatCost } from '../../lib/format';
import { safeHttpsUrl } from '../../lib/queue/format';
import { StewardChip } from '../steward/steward-chip';
import { SavedBadge } from '../token-saver/saved-badge';
import { ApproveRunLink, CardFaceDesign } from './card-design';
import { RestartChip } from './handoff/restart-chip';
import {
  type FaceSelection,
  SelectedTint,
  SelectionBox,
  SelectionFrame,
  toggleOnClick,
  UnselectableMark,
} from './selection-box';
import { TAP, TAP_ROW } from './tap';

/** A chip on the header's 16 px line (C-35). */
const HEAD_CHIP = 'h-4 shrink-0';

const TEXT_LINK = `${TAP} text-xs text-accent-ink underline-offset-2 hover:underline`;

/**
 * What a card shows on the board (C-35, #423): four rows in one column at the
 * card's full width — the **header** (label, Bug, attachments, dependency, and
 * the cost with the menu trigger at its end), the **title**, the **status**
 * (one wrapping row of state, then the approve offer, detail lines and the
 * face's links) and the **footer** (PR and Issue, above a hairline).
 */
export function CardFace({
  projectId,
  card,
  canOperate,
  menu,
  selection,
  hints,
  onOpen,
}: {
  projectId: string;
  card: BoardCardView;
  /** #660: triage hints waiting on the card; absent or 0 is none. */
  hints?: number;
  canOperate: boolean;
  /** The Board's card menu (`slots.menu`), placed at the end of the header. */
  menu?: ReactNode;
  /** #452: set for an operator; a suggestion shows why it has no box instead. */
  selection?: FaceSelection;
  onOpen: (card: BoardCardView) => void;
}) {
  const offer = approveRunOffer(card);
  const pill = roundPill(card.round);
  const badge = shippingBadge(card);
  // #630: a collect that failed is on the face, not only in the sheet.
  const notPushed = collectFailedBadge(card);
  const cost = formatCost(card.costUsd);
  // #337 D8: "after C-12", warning while it is not completed.
  const after = dependencyChip(card.dependsOn);
  // #443: Ready / Waiting of a To Do card with dependencies.
  const ready = readinessChip(card.readiness);
  const suggestion = isSuggestion(card);
  const note = 'break-words text-xs text-ink-2';
  return (
    <SelectionFrame>
      {selection?.selected ? <SelectedTint /> : null}
      <div
        data-card-number={card.number}
        data-select-column={card.column}
        data-selected={selection ? selection.selected : undefined}
        onClickCapture={(event) => toggleOnClick(event, selection)}
        className="relative flex min-w-0 flex-col gap-1.5 text-sm"
      >
        <div
          data-card-row="header"
          // #497: the menu trigger's 44 px touch target stays inside the row.
          className={`flex h-4 min-w-0 items-center gap-1.5 whitespace-nowrap text-xs leading-4 text-ink-2${menu ? ' pointer-coarse:h-(--size-tap)' : ''}`}
        >
          {selection && !suggestion ? (
            <SelectionBox label={card.label} selection={selection} />
          ) : null}
          {selection && suggestion ? (
            <UnselectableMark
              shown={selection.selecting}
              text="Suggestions are accepted or dismissed one by one"
            />
          ) : null}
          <span className="shrink-0 font-mono">{card.label}</span>
          {card.stack ? (
            // #480: the card's stack, wherever the card sits.
            <Chip
              size="sm"
              title={`Part of ${card.stack.label} ${card.stack.title}`}
              className={`${HEAD_CHIP} gap-1 font-mono`}
            >
              <Layers aria-hidden="true" className="size-3" />
              {card.stack.label}
            </Chip>
          ) : null}
          {card.kind === 'bug' ? (
            <Chip size="sm" tone="danger" className={HEAD_CHIP}>
              Bug
            </Chip>
          ) : null}
          {hints ? (
            <Chip
              size="sm"
              title="Triage hints: open the card to apply or dismiss them"
              className={`${HEAD_CHIP} gap-1`}
            >
              <Sparkles aria-hidden="true" className="size-3" />
              {hintsLabel(hints)}
            </Chip>
          ) : null}
          {card.attachmentCount > 0 ? (
            <span
              className="flex shrink-0 items-center gap-0.5 tabular-nums"
              role="img"
              aria-label={attachmentCountLabel(card.attachmentCount)}
              title={attachmentCountLabel(card.attachmentCount)}
            >
              <Paperclip aria-hidden="true" className="size-3" />
              {card.attachmentCount}
            </span>
          ) : null}
          {after ? (
            // The one header item that gives way: it truncates first.
            <Chip
              size="sm"
              tone={after.open ? 'warn' : 'neutral'}
              title={after.title}
              className="h-4 min-w-0 shrink"
            >
              <span className="truncate">{after.text}</span>
            </Chip>
          ) : null}
          {cost || menu || card.tokenSaved ? (
            <span className="ms-auto flex shrink-0 items-center gap-1">
              {cost ? <span className="tabular-nums">{cost}</span> : null}
              <SavedBadge saved={card.tokenSaved} />
              {menu}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className={`${TAP} break-words text-left font-medium underline-offset-2 hover:underline`}
          onClick={() => onOpen(card)}
        >
          {card.title}
        </button>
        <div
          data-card-row="status"
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 empty:hidden"
        >
          {ready ? (
            <Chip
              size="sm"
              tone={ready.tone}
              title={ready.title}
              className="gap-1"
            >
              {ready.tone === 'ok' ? (
                <Check aria-hidden="true" className="size-3" />
              ) : (
                <Clock aria-hidden="true" className="size-3" />
              )}
              {ready.text}
            </Chip>
          ) : null}
          {card.autoRunWhenReady ? (
            <Chip size="sm" title="Auto-run when ready is on" className="gap-1">
              <Zap aria-hidden="true" className="size-3" />
              Auto-run
            </Chip>
          ) : null}
          {ready?.waitsFor ? (
            <span className="text-xs text-ink-3">{ready.waitsFor}</span>
          ) : null}
          {card.tracking ? <TerminalBadges card={card} /> : null}
          {card.fleet ? <FleetBadges card={card} /> : null}
          {suggestion ? <SuggestionBadges card={card} /> : null}
          <CardFaceDesign card={card} />
          {pill ? (
            <StatusPill size="sm" status={pill.status} label={pill.label} />
          ) : null}
          {card.round?.phase === 'background' &&
          card.round.backgroundCommand ? (
            <span
              className="min-w-0 max-w-full truncate font-mono text-xs text-ink-2"
              title={card.round.backgroundCommand}
            >
              {card.round.backgroundCommand}
            </span>
          ) : null}
          {card.round?.blockingDialog ? (
            <Tooltip content={blockingDialogText(card.round.blockingDialog)}>
              <span>
                <Badge tone="warn" size="md" label="Dialog open" />
              </span>
            </Tooltip>
          ) : null}
          {card.round?.finishRefused ? (
            <Tooltip content={finishRefusedText(card.round.finishRefused)}>
              <span>
                <Badge tone="danger" size="md" label="Finish refused" />
              </span>
            </Tooltip>
          ) : null}
          {card.round?.hooksMissing ? (
            <HooksChip projectId={projectId} card={card} round={card.round} />
          ) : null}
          {card.steward ? <StewardChip chip={card.steward} /> : null}
          <RestartChip card={card} />
          {card.autoRunFailure ? (
            <Tooltip content={autoRunFailureText(card.autoRunFailure)}>
              <span>
                <Badge tone="warn" size="md" label="Didn’t start" />
              </span>
            </Tooltip>
          ) : null}
          {notPushed ? (
            <Tooltip content={notPushed.text}>
              <span>
                <Badge tone="warn" size="md" label={notPushed.label} />
              </span>
            </Tooltip>
          ) : null}
          {badge ? (
            <Tooltip content={badge.label}>
              <span>
                <Badge tone={badge.tone} size="md" label={badge.label} />
              </span>
            </Tooltip>
          ) : null}
        </div>
        {offer && canOperate ? (
          <>
            <div
              className={`pointer-coarse:flex pointer-coarse:items-center ${TAP_ROW}`}
            >
              <ApproveRunLink
                projectId={projectId}
                card={card}
                offer={offer}
                variant="glass"
                size="sm"
              />
            </div>
            {offer.reason ? (
              <p className="text-xs text-ink-3">{offer.reason}</p>
            ) : null}
          </>
        ) : null}
        {card.stack ? <p className={note}>part of {card.stack.title}</p> : null}
        {card.fleet ? <p className={note}>{fleetSummary(card.fleet)}</p> : null}
        {suggestion && card.captureWhy ? (
          <p className={note}>{card.captureWhy}</p>
        ) : null}
        <FaceLinks projectId={projectId} card={card} suggestion={suggestion} />
        {card.prNumber !== null || card.issueNumber !== null ? (
          <CardFooter card={card} />
        ) : null}
      </div>
    </SelectionFrame>
  );
}

/** #367 D3: the chip names what the round's launch facts say, not a plugin to set up. */
function HooksChip({
  projectId,
  card,
  round,
}: {
  projectId: string;
  card: BoardCardView;
  round: CardRoundBrief;
}) {
  const notice = hooksNotice(card, round);
  return (
    <Tooltip content={notice.text}>
      {notice.guide ? (
        <NextLink
          href={hooksGuideHref(projectId)}
          className={TAP}
          aria-label={`${notice.chip}. ${HOOKS_GUIDE_LABEL}`}
        >
          <Chip size="sm">{notice.chip}</Chip>
        </NextLink>
      ) : (
        <span>
          <Chip size="sm">{notice.chip}</Chip>
        </span>
      )}
    </Tooltip>
  );
}

/** #282 D1: a card tracked from a terminal session: the badge and the state. */
function TerminalBadges({ card }: { card: BoardCardView }) {
  return (
    <>
      <Tooltip content={TRACKED_TEXT}>
        <span>
          <Badge tone="neutral" size="sm" label="Terminal" />
        </span>
      </Tooltip>
      {isSessionAlive(card) ? (
        <StatusPill size="sm" status="running" label="Session running" />
      ) : null}
      {card.autoCollect ? <Chip size="sm">Automatic work</Chip> : null}
    </>
  );
}

/** #282 D4: a mirrored fleet slot: the badge and "Slot gone". */
function FleetBadges({ card }: { card: BoardCardView }) {
  return (
    <>
      <Badge tone="neutral" size="sm" label="Fleet" />
      {card.fleet?.slotGone ? (
        <Tooltip content="The slot left the fleet; the card keeps its last column.">
          <span>
            <Badge tone="warn" size="sm" label={SLOT_GONE_TEXT} />
          </span>
        </Tooltip>
      ) : null}
    </>
  );
}

/** #244: an Inbox card's badge and the model's confidence. */
function SuggestionBadges({ card }: { card: BoardCardView }) {
  const confidence = confidenceLabel(card.captureConfidence);
  return (
    <>
      <Badge tone="warn" size="sm" label="Suggested" />
      {confidence ? (
        <span className="text-xs tabular-nums text-ink-2">
          {confidence} sure
        </span>
      ) : null}
    </>
  );
}

/** The last line of the status: where the terminal, fleet or suggestion face leads. */
function FaceLinks({
  projectId,
  card,
  suggestion,
}: {
  projectId: string;
  card: BoardCardView;
  suggestion: boolean;
}) {
  const session = card.tracking ? trackedSessionHref(card) : null;
  const fleet = card.fleet ? fleetHref(projectId, card) : null;
  const source = suggestion ? sessionHref(card.sourceSessionId) : null;
  if (!session && !fleet && !source) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {session ? (
        <NextLink href={session} className={TEXT_LINK}>
          Session
        </NextLink>
      ) : null}
      {fleet ? (
        <NextLink href={fleet} className={TEXT_LINK}>
          Open in Fleet
        </NextLink>
      ) : null}
      {source ? (
        <NextLink href={source} className={TEXT_LINK}>
          Source session
        </NextLink>
      ) : null}
    </div>
  );
}

/** The PR (with its CI dot) and the Issue, above a hairline. */
function CardFooter({ card }: { card: BoardCardView }) {
  const dot = ciDot(card);
  const prHref = card.prUrl ? safeHttpsUrl(card.prUrl) : null;
  const issueHref = card.issueUrl ? safeHttpsUrl(card.issueUrl) : null;
  return (
    <div
      data-card-row="footer"
      className="mt-0.5 flex flex-wrap items-center gap-1.5 border-line border-t pt-1.5 text-xs pointer-coarse:gap-y-0 pointer-coarse:pt-0"
    >
      {card.prNumber !== null ? (
        <Link href={prHref}>
          {card.prState === 'merged' ? (
            <GitMerge aria-hidden="true" className="size-3 text-status-done" />
          ) : null}
          {prChipText(card)}
        </Link>
      ) : null}
      {card.prNumber !== null && dot ? (
        <span
          role="img"
          aria-label={dot.label}
          title={dot.label}
          className="inline-flex"
        >
          <Badge tone={dot.tone} dot />
        </span>
      ) : null}
      {card.issueNumber !== null ? (
        <Link href={issueHref}>Issue #{card.issueNumber}</Link>
      ) : null}
    </div>
  );
}

function Link({
  href,
  children,
}: {
  href: string | null;
  children: ReactNode;
}) {
  if (!href) return <Chip size="sm">{children}</Chip>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      // #497: the anchor is the touch target; the pill inside is what is drawn.
      className={`group/link inline-flex items-center ${TAP}`}
    >
      <span className="inline-flex h-5 items-center gap-1 rounded-full bg-hover px-2 text-ink-2 tabular-nums underline-offset-2 group-hover/link:text-ink group-hover/link:underline">
        {children}
      </span>
    </a>
  );
}
