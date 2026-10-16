'use client';

import {
  type AttachmentView,
  BOARD_CARD_BODY_MAX,
  BOARD_CARD_KINDS,
  BOARD_CARD_TITLE_MAX,
  type BoardCardDetail,
  type BoardCardKind,
  CARD_FEEDBACK_MAX,
  type CardRoundView,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { Field, Input, Select, Textarea } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Timeline, type TimelineItem } from '@andrewbehma/glass-ui/timeline';
import { toast } from '@andrewbehma/glass-ui/toast';
import NextLink from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import {
  describeUploadFailure,
  splitByRound,
} from '../../lib/attachments/format';
import { useAttachmentUploads } from '../../lib/attachments/use-attachment-uploads';
import { fetchCard, sendFeedback, updateCard } from '../../lib/board/actions';
import {
  AUTO_COLLECT_HINT,
  AUTO_COLLECT_LABEL,
  approveRunOffer,
  autoRunReason,
  COLUMN_TITLE,
  canAccept,
  canDelete,
  canGiveFeedback,
  canMarkFinished,
  canRetry,
  canRun,
  canStop,
  describeBoardError,
  FLEET_EDIT_HINT,
  fleetHref,
  fleetSummary,
  HOOKS_GUIDE_LABEL,
  hooksGuideHref,
  hooksNotice,
  isFleetCard,
  isTerminalCard,
  phaseLabel,
  roundPill,
  SLOT_GONE_TEXT,
  sessionHref,
  TRACKED_TEXT,
  trackedSessionHref,
  trackedStatusText,
} from '../../lib/board/format';
import {
  canCreatePr,
  noPrText,
  prChipText,
} from '../../lib/board/pull-request';
import { ciBanner, pullRequestRows } from '../../lib/board/shipping';
import { formatCost } from '../../lib/format';
import { Time } from '../../lib/format/time';
import { safeHttpsUrl } from '../../lib/queue/format';
import { useReadiness } from '../../lib/readiness/use-readiness';
import { type TextNotes, useTextNotes } from '../../lib/text/use-text-notes';
import { AttachmentDropzone } from '../attachments/attachment-dropzone';
import { AttachmentList } from '../attachments/attachment-list';
import { CardAttachmentsSection } from '../attachments/card-attachments-section';
import { useRemoveAttachment } from '../attachments/use-remove-attachment';
import { Markdown } from '../markdown/markdown';
import { ReadinessNotice } from '../readiness/readiness-notice';
import { useCurrentUser } from '../shell/user-context';
import { NormalizedNote } from '../text/normalized-note';
import { CardDependenciesSection } from './card-dependencies';
import { ApproveRunLink, CardDesignSection } from './card-design';
import { AutoCollectToggle, CardOptionToggles } from './card-options';
import { LaunchPopover } from './launch-popover';
import { SuggestionSheetBody } from './suggestion-sheet';
import type { CardActions } from './use-card-actions';

const KIND_LABEL: Record<BoardCardKind, string> = {
  feature: 'Feature',
  bug: 'Bug',
};

/** The terminal button's state: offered, or disabled with the reason (D11). */
export type TerminalAccess =
  | { state: 'available'; open: () => void }
  | { state: 'disabled'; reason: string };

function roundTone(round: CardRoundView): TimelineItem['tone'] {
  if (round.phase === 'failed') return 'danger';
  if (round.phase === 'finished') return 'ok';
  if (round.phase === 'waiting' || round.phase === 'ended') return 'warn';
  return 'neutral';
}

/** What the rounds' attachment lists need: who is looking, and what Remove does. */
interface RoundAttachments {
  byRound: Map<string, AttachmentView[]>;
  user: { id: string; role: string };
  canRemove: boolean;
  removing?: string;
  onRemove: (attachment: AttachmentView) => void;
}

function roundItems(
  rounds: CardRoundView[],
  notes: TextNotes,
  canOperate: boolean,
  files: RoundAttachments,
): TimelineItem[] {
  return rounds.map((round) => {
    const cost = formatCost(round.costUsd);
    return {
      id: round.id,
      at: round.startedAt,
      tone: roundTone(round),
      actor: round.author ? { name: round.author.email } : undefined,
      title: (
        <span>
          Round {round.round} ·{' '}
          {round.trigger === 'feedback' ? 'feedback' : 'run'} ·{' '}
          {phaseLabel(round.phase)}
        </span>
      ),
      meta: (
        <span className="flex flex-col gap-1 text-xs">
          {round.feedback ? (
            <span className="whitespace-pre-wrap break-words">
              “{round.feedback}”
            </span>
          ) : null}
          {round.feedback ? (
            <NormalizedNote
              view={notes.view('board_card_round', round.id, 'feedback')}
              canOperate={canOperate}
              onRetry={notes.retry}
            />
          ) : null}
          <AttachmentList
            attachments={files.byRound.get(round.id) ?? []}
            user={files.user}
            canRemove={files.canRemove}
            removing={files.removing}
            onRemove={files.onRemove}
          />
          {round.summary ? (
            <span className="whitespace-pre-wrap break-words">
              {round.summary}
            </span>
          ) : null}
          {round.error ? (
            <span className="text-danger">{round.error}</span>
          ) : null}
          {round.hooksMissing ? (
            // A round is a runner launch, whatever the card's source.
            <span>{hooksNotice({ source: 'manual' }, round).text}</span>
          ) : null}
          {cost ? <span className="tabular-nums">{cost}</span> : null}
        </span>
      ),
    };
  });
}

function Links({ card }: { card: BoardCardDetail }) {
  const pr = card.prUrl ? safeHttpsUrl(card.prUrl) : null;
  const issue = card.issueUrl ? safeHttpsUrl(card.issueUrl) : null;
  const items = [
    card.prNumber !== null && { label: prChipText(card) ?? '', href: pr },
    card.issueNumber !== null && {
      label: `Issue #${card.issueNumber}`,
      href: issue,
    },
  ].filter((x): x is { label: string; href: string | null } => x !== false);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3 text-sm">
      {items.map(({ label, href }) =>
        href ? (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {label}
          </a>
        ) : (
          <span key={label}>{label}</span>
        ),
      )}
    </div>
  );
}

/** #359 D8: every PR of the card, newest first; shown from the second PR on. */
function PullRequestList({ card }: { card: BoardCardDetail }) {
  const rows = pullRequestRows(card);
  if (rows.length < 2) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm" aria-label="Pull requests">
      {rows.map((row) => {
        const href = safeHttpsUrl(row.url);
        const text = `PR #${row.number} · ${row.state}`;
        return (
          <li key={row.number} className="flex flex-wrap gap-2">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {text}
              </a>
            ) : (
              <span>{text}</span>
            )}
            <span className="text-ink-3">{row.branch}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** #359 D6: automation stopped on a red CI — names the failed checks and what the person can do. */
function CiStoppedBanner({ card }: { card: BoardCardDetail }) {
  const banner = ciBanner(card);
  if (!banner) return null;
  return (
    <Banner tone="danger">
      <div className="flex flex-col gap-1">
        <span>{banner.title}</span>
        {banner.checks.length > 0 ? (
          <ul className="list-disc pl-4">
            {banner.checks.map((check) => {
              const href = check.link ? safeHttpsUrl(check.link) : null;
              return (
                <li key={check.name}>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer">
                      {check.name}
                    </a>
                  ) : (
                    check.name
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        <span>{banner.hint}</span>
      </div>
    </Banner>
  );
}

const FORM_ID = 'board-card-form';

/** The sheet of one card (#273 D17): Run, Design, Rounds, then the Card form with Save pinned. */
function CardDetailBody({
  sheetTitle,
  projectId,
  card,
  canOperate,
  actions,
  terminal,
  onSaved,
}: {
  sheetTitle: string;
  projectId: string;
  card: BoardCardDetail;
  canOperate: boolean;
  actions: CardActions;
  terminal: TerminalAccess;
  onSaved: () => void;
}) {
  const readiness = useReadiness(projectId);
  const runBlocked = readiness.blockers('run').length > 0;
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [kind, setKind] = useState(card.kind);
  const [issueOnRun, setIssueOnRun] = useState(card.issueOnRun);
  const [specOnRun, setSpecOnRun] = useState(card.specOnRun);
  const [autoCollect, setAutoCollect] = useState(card.autoCollect);
  const [preview, setPreview] = useState(false);
  const fleet = isFleetCard(card);
  const terminalCard = isTerminalCard(card);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [sending, setSending] = useState(false);
  const user = useCurrentUser();
  const feedbackFiles = useAttachmentUploads(projectId);
  const { removing, remove } = useRemoveAttachment(projectId, onSaved);
  const { card: cardFiles, byRound } = splitByRound(card.attachments);
  const filesEditable = canOperate && card.column !== 'completed';
  const notes = useTextNotes(
    projectId,
    { cardId: card.id },
    `${card.title}\n${card.body}\n${card.rounds.length}`,
  );

  // The English text lands after the save (#271): a field the person has not
  // touched since follows the card; a field they are typing in stays.
  const shown = useRef({ title: card.title, body: card.body });
  useEffect(() => {
    setTitle((t) => (t === shown.current.title ? card.title : t));
    setBody((b) => (b === shown.current.body ? card.body : b));
    shown.current = { title: card.title, body: card.body };
  }, [card.title, card.body]);

  // A newer card (a live push) replaces the form unless the person is typing.
  const dirty =
    title !== card.title ||
    body !== card.body ||
    kind !== card.kind ||
    issueOnRun !== card.issueOnRun ||
    specOnRun !== card.specOnRun ||
    autoCollect !== card.autoCollect;

  const save = async () => {
    setSaving(true);
    try {
      // #282 D4: a fleet card edits title and text only. D3: `autoCollect`
      // belongs to a terminal card; any other card is refused `not_tracked`.
      await updateCard(
        projectId,
        card.number,
        fleet
          ? { title: title.trim(), body }
          : {
              title: title.trim(),
              body,
              kind,
              issueOnRun,
              specOnRun,
              ...(terminalCard ? { autoCollect } : {}),
            },
      );
      toast.success(
        fleet
          ? `${card.label} saved. A running slot gets the change.`
          : `${card.label} saved. It applies from the next round.`,
      );
      onSaved();
    } catch (err) {
      toast.error(describeBoardError(err));
    } finally {
      setSaving(false);
    }
  };

  const sendBack = async () => {
    setSending(true);
    try {
      await sendFeedback(projectId, card.number, {
        text: feedback.trim(),
        ...(feedbackFiles.done.length > 0
          ? { attachmentIds: feedbackFiles.done.map((d) => d.view.id) }
          : {}),
      });
      toast.success(`Feedback sent. ${card.label} is back in progress.`);
      setFeedback('');
      feedbackFiles.forget(feedbackFiles.done.map((d) => d.item));
      onSaved();
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.body?.error === 'attachment_error'
          ? describeUploadFailure(err.status, err.body)
          : describeBoardError(err),
      );
    } finally {
      setSending(false);
    }
  };

  // Auto until a person changes it (saving a different kind pins it).
  const autoKind = card.kindSource === 'auto' && kind === card.kind;

  const pill = roundPill(card.round);
  const total = formatCost(card.costUsd);

  const offer = approveRunOffer(card);
  const failure = card.autoRunFailure;

  return (
    <SheetContent
      side="right"
      title={sheetTitle}
      description="Board card"
      footer={
        canOperate ? (
          <div className="flex items-center justify-end gap-2">
            {canDelete(card) ? (
              <Button
                variant="ghost"
                type="button"
                disabled={actions.busy}
                onClick={() => actions.askDelete(card)}
              >
                Delete
              </Button>
            ) : null}
            <Button
              variant="solid"
              type="submit"
              form={FORM_ID}
              disabled={saving || !dirty || title.trim() === ''}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        <section aria-label="Run" className="flex flex-col gap-4">
          <SectionHeader title="Run" headingLevel={3} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{COLUMN_TITLE[card.column]}</span>
            {pill ? (
              <StatusPill size="sm" status={pill.status} label={pill.label} />
            ) : null}
            {total ? (
              <span className="ml-auto tabular-nums text-ink-2">{total}</span>
            ) : null}
          </div>
          <Links card={card} />
          <PullRequestList card={card} />
          <CiStoppedBanner card={card} />
          {canCreatePr(card) ? (
            <div className="flex flex-col gap-2">
              <Banner tone={noPrText(card).tone}>{noPrText(card).text}</Banner>
              {canOperate ? (
                <div>
                  <Button
                    variant="glass"
                    disabled={actions.busy || card.collectState === 'pending'}
                    onClick={() => void actions.createPullRequest(card)}
                  >
                    Create pull request
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {card.source === 'captured' && sessionHref(card.sourceSessionId) ? (
            <p className="text-xs text-ink-2">
              Suggested from{' '}
              <NextLink
                href={sessionHref(card.sourceSessionId) ?? '#'}
                className="text-accent-ink underline-offset-2 hover:underline"
              >
                a Claude Code session
              </NextLink>
              .
            </p>
          ) : null}
          {card.tracking ? (
            <div className="flex flex-col gap-1 text-xs text-ink-2">
              <p>
                {TRACKED_TEXT}
                {trackedSessionHref(card) ? (
                  <>
                    {' · '}
                    <NextLink
                      href={trackedSessionHref(card) ?? '#'}
                      className="text-accent-ink underline-offset-2 hover:underline"
                    >
                      Open the session
                    </NextLink>
                  </>
                ) : null}
              </p>
              <p>{trackedStatusText(card)}</p>
            </div>
          ) : null}
          {card.fleet ? (
            <div className="flex flex-col gap-1 text-xs text-ink-2">
              <p>
                Fleet · issue #{card.fleet.issue} · {fleetSummary(card.fleet)}
                {fleetHref(projectId, card) ? (
                  <>
                    {' · '}
                    <NextLink
                      href={fleetHref(projectId, card) ?? '#'}
                      className="text-accent-ink underline-offset-2 hover:underline"
                    >
                      Open in Fleet
                    </NextLink>
                  </>
                ) : null}
              </p>
              {card.fleet.slotGone ? (
                <Badge tone="warn" label={SLOT_GONE_TEXT} />
              ) : null}
            </div>
          ) : null}
          {card.branch ? (
            <p className="break-all font-mono text-xs text-ink-2">
              {card.branch}
            </p>
          ) : null}
          {card.round?.hooksMissing
            ? (() => {
                const notice = hooksNotice(card, card.round);
                return (
                  <div className="flex flex-col gap-2 text-xs text-ink-2">
                    <p>{notice.text}</p>
                    {notice.commands.map((item) => (
                      <div key={item.code} className="flex flex-col gap-1">
                        <span>{item.label}</span>
                        <CodeBlock code={item.code} defaultWrap />
                      </div>
                    ))}
                    {notice.guide ? (
                      <NextLink
                        href={hooksGuideHref(projectId)}
                        className="text-accent-ink underline-offset-2 hover:underline"
                      >
                        {HOOKS_GUIDE_LABEL}
                      </NextLink>
                    ) : null}
                  </div>
                );
              })()
            : null}

          {failure ? (
            <Banner tone="warn">
              Design approved — the worker did not start:{' '}
              {autoRunReason(failure)}.
            </Banner>
          ) : null}

          {canOperate ? (
            <div className="flex flex-wrap gap-2">
              {canAccept(card) ? (
                <Button
                  variant="solid"
                  disabled={actions.busy}
                  onClick={() => actions.accept(card)}
                >
                  Accept
                </Button>
              ) : null}
              {canRun(card) || canRetry(card) ? (
                <LaunchPopover
                  projectId={projectId}
                  card={card}
                  kind="work"
                  label={canRetry(card) ? 'Run again' : 'Run'}
                  variant={card.column === 'todo' ? 'solid' : 'glass'}
                  disabled={actions.busy || runBlocked}
                  describedBy={runBlocked ? 'board-run-reason' : undefined}
                  onLaunch={async (request) => {
                    // The toast says why; a refusal keeps the popover open.
                    if (!(await actions.run(card, request))) {
                      throw new Error('run refused');
                    }
                  }}
                />
              ) : null}
              {offer ? (
                <ApproveRunLink
                  projectId={projectId}
                  card={card}
                  offer={offer}
                  variant={card.column === 'todo' ? 'solid' : 'glass'}
                  describedBy="board-approve-run-reason"
                />
              ) : null}
              {canMarkFinished(card) ? (
                <Button
                  variant="glass"
                  disabled={actions.busy}
                  onClick={() => actions.markFinished(card)}
                >
                  Mark finished
                </Button>
              ) : null}
              {canStop(card) ? (
                <Button
                  variant="glass"
                  disabled={actions.busy}
                  onClick={() => actions.askStop(card)}
                >
                  Stop
                </Button>
              ) : null}
              {card.sessionId ? (
                terminal.state === 'available' ? (
                  <Button variant="glass" onClick={terminal.open}>
                    Open terminal
                  </Button>
                ) : (
                  <Button variant="glass" disabled title={terminal.reason}>
                    Open terminal
                  </Button>
                )
              ) : null}
            </div>
          ) : null}
          {canOperate && (canRun(card) || canRetry(card)) ? (
            <div className="-mt-3">
              <ReadinessNotice
                id="board-run-reason"
                projectId={projectId}
                action="run"
                readiness={readiness}
              />
            </div>
          ) : null}
          {canOperate && offer?.reason ? (
            <p
              id="board-approve-run-reason"
              className="-mt-3 text-xs text-ink-3"
            >
              {offer.reason}
            </p>
          ) : null}
          {canOperate && card.sessionId && terminal.state === 'disabled' ? (
            <p className="-mt-3 text-xs text-ink-3">{terminal.reason}</p>
          ) : null}

          {canGiveFeedback(card) && canOperate ? (
            <Field
              label="Send back with feedback"
              htmlFor="board-feedback"
              hint="Resumes the same Claude session in the same worktree. The card returns to In progress."
            >
              <Textarea
                id="board-feedback"
                rows={4}
                value={feedback}
                maxLength={CARD_FEEDBACK_MAX}
                onChange={(e) => setFeedback(e.target.value)}
              />
              <div className="mt-2">
                <AttachmentDropzone
                  uploads={feedbackFiles}
                  label="Attach files to the feedback"
                />
              </div>
              <div className="mt-2">
                <Button
                  variant="glass"
                  disabled={
                    sending || feedbackFiles.busy || feedback.trim() === ''
                  }
                  onClick={sendBack}
                >
                  {sending ? 'Sending…' : 'Send back'}
                </Button>
              </div>
            </Field>
          ) : null}
        </section>

        {fleet ? null : (
          <CardDesignSection
            projectId={projectId}
            card={card}
            canOperate={canOperate}
            onChanged={onSaved}
          />
        )}

        <CardDependenciesSection
          projectId={projectId}
          card={card}
          canOperate={canOperate}
          onChanged={onSaved}
        />

        <section aria-label="Rounds" className="flex flex-col gap-2">
          <SectionHeader title="Rounds" headingLevel={3} />
          <Timeline
            items={roundItems(card.rounds, notes, canOperate, {
              byRound,
              user,
              canRemove: filesEditable,
              removing,
              onRemove: (a) => void remove(a),
            })}
            empty={<p className="text-sm text-ink-3">No worker has run yet.</p>}
          />
        </section>

        <CardAttachmentsSection
          projectId={projectId}
          number={card.number}
          attachments={cardFiles}
          user={user}
          canOperate={canOperate}
          completed={card.column === 'completed'}
          removing={removing}
          onRemove={(a) => void remove(a)}
          onChanged={onSaved}
        />

        <form
          id={FORM_ID}
          aria-label="Card"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && title.trim() !== '' && !saving) void save();
          }}
        >
          <SectionHeader title="Card" headingLevel={3} />
          {fleet ? (
            <p className="-mt-2 text-xs text-ink-3">{FLEET_EDIT_HINT}</p>
          ) : card.sessionId ? (
            <p className="-mt-2 text-xs text-ink-3">
              Changes go to the worker with the next round.
            </p>
          ) : null}
          <Field label="Title" htmlFor="board-card-title">
            <Input
              id="board-card-title"
              value={title}
              maxLength={BOARD_CARD_TITLE_MAX}
              disabled={!canOperate}
              onChange={(e) => setTitle(e.target.value)}
            />
            <NormalizedNote
              view={notes.view('board_card', card.id, 'title')}
              canOperate={canOperate}
              onRetry={notes.retry}
            />
          </Field>
          <Field label="What to do" htmlFor="board-card-body">
            {preview ? (
              <div className="rounded-control bg-surface p-3">
                <Markdown>{body || '*Nothing written yet.*'}</Markdown>
              </div>
            ) : (
              <Textarea
                id="board-card-body"
                rows={8}
                value={body}
                maxLength={BOARD_CARD_BODY_MAX}
                disabled={!canOperate}
                onChange={(e) => setBody(e.target.value)}
              />
            )}
            <div className="mt-2">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setPreview((p) => !p)}
              >
                {preview ? 'Edit' : 'Preview'}
              </Button>
            </div>
            <NormalizedNote
              view={notes.view('board_card', card.id, 'body')}
              canOperate={canOperate}
              onRetry={notes.retry}
            />
          </Field>
          <Field
            label="Kind"
            htmlFor="board-card-kind"
            hint={
              autoKind
                ? 'Set automatically from the text. Change it to pin it.'
                : undefined
            }
          >
            <Select
              id="board-card-kind"
              value={kind}
              disabled={!canOperate || fleet}
              onChange={(e) =>
                setKind(
                  BOARD_CARD_KINDS.find((k) => k === e.target.value) ?? kind,
                )
              }
            >
              {BOARD_CARD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
            {autoKind ? (
              <div className="mt-2">
                <Badge tone="neutral" label="Auto" />
              </div>
            ) : null}
          </Field>
          {fleet ? null : (
            <CardOptionToggles
              projectId={projectId}
              idPrefix="board-card"
              issueOnRun={issueOnRun}
              specOnRun={specOnRun}
              disabled={!canOperate || card.round !== null}
              onIssueOnRun={setIssueOnRun}
              onSpecOnRun={setSpecOnRun}
            />
          )}
          {terminalCard ? (
            <AutoCollectToggle
              id="board-card-auto-collect"
              checked={autoCollect}
              disabled={!canOperate}
              label={AUTO_COLLECT_LABEL}
              hint={AUTO_COLLECT_HINT}
              onChange={setAutoCollect}
            />
          ) : null}
          {card.specPath ? (
            <p className="break-all font-mono text-xs text-ink-2">
              Spec: {card.specPath}
            </p>
          ) : null}
          <span className="text-xs text-ink-3">
            Created <Time value={card.createdAt} />
            {card.createdBy ? ` by ${card.createdBy.email}` : ''}
          </span>
        </form>
      </div>
    </SheetContent>
  );
}

/** The latest detail for card `number`, refetched when `version` changes (a live push). */
export function CardSheet({
  projectId,
  number,
  title,
  version,
  canOperate,
  actions,
  terminal,
  onChanged,
  onClose,
}: {
  projectId: string;
  number: number | undefined;
  title: string | undefined;
  version: number;
  canOperate: boolean;
  actions: CardActions;
  terminal: TerminalAccess;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [card, setCard] = useState<BoardCardDetail>();
  const [error, setError] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is a refetch trigger
  useEffect(() => {
    if (number === undefined) return;
    let cancelled = false;
    fetchCard(projectId, number)
      .then((detail) => {
        if (cancelled) return;
        setCard(detail);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeBoardError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, number, version]);

  const sheetTitle = `C-${number} ${title ?? ''}`.trim();

  const close = () => {
    setCard(undefined);
    setError(undefined);
    onClose();
  };

  return (
    <SheetRoot
      open={number !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {number !== undefined ? (
        card && card.number === number && !error && card.column !== 'inbox' ? (
          <CardDetailBody
            // A new round resets the form; a push mid-typing does not.
            key={`${card.id}:${card.rounds.length}`}
            sheetTitle={sheetTitle}
            projectId={projectId}
            card={card}
            canOperate={canOperate}
            actions={actions}
            terminal={terminal}
            onSaved={onChanged}
          />
        ) : (
          <SheetContent
            side="right"
            title={sheetTitle}
            description="Board card"
          >
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : card && card.number === number ? (
              <SuggestionSheetBody
                key={card.id}
                projectId={projectId}
                card={card}
                canOperate={canOperate}
                actions={actions}
                onDone={close}
              />
            ) : (
              <Skeleton className="h-64 w-full" />
            )}
          </SheetContent>
        )
      ) : null}
    </SheetRoot>
  );
}
