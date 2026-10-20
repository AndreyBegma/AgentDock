'use client';

import type {
  ActionRequestSummary,
  ApprovalItemView,
  ApprovalsView,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { ListDetail } from '@andrewbehma/glass-ui/list-detail';
import { Section } from '@andrewbehma/glass-ui/section';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { useBreakpoint } from '@andrewbehma/glass-ui/use-breakpoint';
import { Check } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  Countdown,
  RecentRequests,
  RequestCell,
  useActionRequestDecisions,
  useCountdownNow,
} from '../../../../../components/approvals/action-requests';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import {
  pendingRequests,
  requestTitle,
  secondsLeft,
} from '../../../../../lib/approvals/action-requests';
import {
  approvalSettingsHref,
  deciderLabel,
  emptyWaitingCopy,
  mismatchSentence,
  SOURCE_LABEL,
  SOURCE_TOOLTIP,
  STATUS_LABEL,
  STATUS_TONE,
} from '../../../../../lib/approvals/format';
import {
  type NeedsYouItem,
  needsYouItems,
  requestKey,
} from '../../../../../lib/approvals/needs-you';
import { CHECKS_LABEL, CHECKS_TONE } from '../../../../../lib/fleet/format';
import { Time } from '../../../../../lib/format/time';
import { safeHttpsUrl } from '../../../../../lib/queue/format';
import type { Section as SectionData } from '../../../../../lib/section/use-section';
import { ApprovalPane, ApprovalSheet } from './approval-sheet';

/** Below 44 px a decision is a miss on a phone; from tablet up, the row's size. */
const THUMB = 'max-tablet:min-h-11 max-tablet:flex-1';

function PrLink({ item }: { item: ApprovalItemView }) {
  const href = safeHttpsUrl(item.url);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline-offset-2 hover:underline"
    >
      #{item.pr}
    </a>
  ) : (
    <>#{item.pr}</>
  );
}

function SourceBadge({ item }: { item: ApprovalItemView }) {
  return (
    <Tooltip content={SOURCE_TOOLTIP[item.source]}>
      <span className="inline-flex">
        <Badge
          tone={item.source === 'derived' ? 'neutral' : 'ok'}
          label={SOURCE_LABEL[item.source]}
        />
      </span>
    </Tooltip>
  );
}

function PrMeta({ item }: { item: ApprovalItemView }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
      <span className="font-mono">#{item.pr}</span>
      {item.slot ? <span>{item.slot}</span> : null}
      {item.checks ? (
        <span className="inline-flex items-center gap-1">
          <Badge dot tone={CHECKS_TONE[item.checks]} aria-hidden="true" />
          {CHECKS_LABEL[item.checks]}
        </span>
      ) : null}
      <span>
        waiting <Time value={item.waitingSince} />
      </span>
      <SourceBadge item={item} />
    </span>
  );
}

/**
 * One row of "Waiting on you". The row's body picks it for the detail beside
 * the list (tablet and up) or opens its sheet (a phone); an action request's
 * Deny and Approve sit on the row itself, full width under the thumb on a
 * phone.
 */
function NeedsYouRow({
  entry,
  selected,
  now,
  canOperate,
  busy,
  onPick,
  onDecide,
}: {
  entry: NeedsYouItem;
  selected: boolean;
  now: number;
  canOperate: boolean;
  busy: boolean;
  onPick: () => void;
  onDecide: (request: ActionRequestSummary, approve: boolean) => void;
}) {
  const request = entry.kind === 'request' ? entry.request : undefined;
  const title =
    entry.kind === 'pr'
      ? (entry.item.title ?? `Pull request #${entry.item.pr}`)
      : requestTitle(entry.request);
  return (
    <li
      className={`flex flex-wrap items-start gap-x-3 gap-y-3 border-b border-line px-4 py-3 last:border-b-0 ${selected ? 'tablet:bg-accent-soft' : ''}`}
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        aria-label={
          entry.kind === 'pr'
            ? `Review pull request ${entry.item.pr}: ${title}`
            : `Details: ${title}`
        }
        onClick={onPick}
        className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded-control text-left"
      >
        <span className="flex flex-wrap items-center gap-2">
          <Badge
            tone="warn"
            label={entry.kind === 'pr' ? 'Merge' : 'Request'}
          />
          {request ? (
            <Countdown expiresAt={request.expiresAt} now={now} />
          ) : null}
        </span>
        {request ? (
          <>
            {/* A phone has no detail pane: the whole request is on the row. */}
            <span className="w-full tablet:hidden">
              <RequestCell request={request} />
            </span>
            <span className="font-medium break-words max-tablet:hidden">
              {title}
            </span>
          </>
        ) : (
          <>
            <span className="font-medium break-words">{title}</span>
            {entry.kind === 'pr' ? <PrMeta item={entry.item} /> : null}
          </>
        )}
      </button>
      {request && canOperate ? (
        <div className="flex gap-2 max-tablet:w-full">
          <Button
            variant="ghost"
            size="sm"
            className={THUMB}
            disabled={busy}
            aria-label={`Deny: ${title}`}
            onClick={() => onDecide(request, false)}
          >
            Deny
          </Button>
          <Button
            variant="glass"
            size="sm"
            className={THUMB}
            disabled={busy || secondsLeft(request.expiresAt, now) === 0}
            aria-label={`Approve: ${title}`}
            onClick={() => onDecide(request, true)}
          >
            <Check aria-hidden="true" className="size-4" />
            Approve
          </Button>
        </div>
      ) : null}
      {entry.kind === 'pr' ? (
        <Button
          variant="glass"
          size="sm"
          className={`tablet:hidden ${THUMB}`}
          aria-label={`Review pull request ${entry.item.pr}`}
          onClick={onPick}
        >
          Review
        </Button>
      ) : null}
    </li>
  );
}

/** An action request beside the list, from tablet up. */
function RequestPane({
  request,
  now,
  canOperate,
  busy,
  onDecide,
}: {
  request: ActionRequestSummary;
  now: number;
  canOperate: boolean;
  busy: boolean;
  onDecide: (request: ActionRequestSummary, approve: boolean) => void;
}) {
  const title = requestTitle(request);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-ink-2">Action request</p>
        <h3 className="text-base font-semibold break-words">{title}</h3>
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <span>
            asked <Time value={request.createdAt} />
          </span>
          <Countdown expiresAt={request.expiresAt} now={now} />
        </p>
      </div>
      {canOperate ? (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={busy}
            aria-label={`Deny: ${title}`}
            onClick={() => onDecide(request, false)}
          >
            Deny
          </Button>
          <Button
            variant="glass"
            disabled={busy || secondsLeft(request.expiresAt, now) === 0}
            aria-label={`Approve: ${title}`}
            onClick={() => onDecide(request, true)}
          >
            <Check aria-hidden="true" className="size-4" />
            Approve
          </Button>
        </div>
      ) : null}
      <RequestCell request={request} />
    </div>
  );
}

function RecentMerges({
  view,
  onOpen,
}: {
  view: ApprovalsView;
  onOpen: (item: ApprovalItemView) => void;
}) {
  if (view.recent.length === 0) return null;
  return (
    <Section title="Recent merge decisions" surface="none">
      <Table scroll>
        <TableHead>
          <TableRow>
            <TableCell head>PR</TableCell>
            <TableCell head>Decision</TableCell>
            <TableCell head>By</TableCell>
            <TableCell head>When</TableCell>
            <TableCell head>Note</TableCell>
            <TableCell head>
              <span className="sr-only">Details</span>
            </TableCell>
          </TableRow>
        </TableHead>
        <tbody>
          {view.recent.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <PrLink item={item} />
                {item.title ? (
                  <span className="block text-xs text-ink-3">{item.title}</span>
                ) : null}
              </TableCell>
              <TableCell>
                <Badge
                  tone={STATUS_TONE[item.status]}
                  label={STATUS_LABEL[item.status]}
                />
              </TableCell>
              <TableCell>{deciderLabel(item)}</TableCell>
              <TableCell>
                <Time value={item.decidedAt ?? item.updatedAt} />
              </TableCell>
              <TableCell>
                <span className="line-clamp-2 break-words">
                  {item.note ?? '—'}
                </span>
              </TableCell>
              <TableCell>
                <div className="flex justify-end">
                  <Button
                    variant="glass"
                    size="sm"
                    aria-label={`Details for pull request ${item.pr}`}
                    onClick={() => onOpen(item)}
                  >
                    Details
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </Table>
    </Section>
  );
}

/**
 * The Queue page's Approvals tab (C-284): what waits on a person — pull
 * requests before the orchestrator merges them, and what Claude Code sessions
 * ask to do — in one list. From tablet up the list sits beside the picked
 * row's detail; on a phone a pull request opens in a bottom sheet with its
 * decision pinned to the bottom edge. AgentDock never merges itself.
 */
export function ApprovalsTab({
  projectId,
  runnerName,
  canOperate,
  approvals,
  actionRequests,
  version,
  onApprovalsChanged,
}: {
  projectId: string;
  runnerName?: string | null;
  canOperate: boolean;
  approvals: SectionData<ApprovalsView>;
  actionRequests: SectionData<ActionRequestSummary[]>;
  /** Bumped by a live push; the open detail refetches on it. */
  version: number;
  onApprovalsChanged: () => void;
}) {
  const phone = useBreakpoint() === 'phone';
  // A notification's link names the request it is about.
  const linked = useSearchParams().get('actionRequest');
  const [picked, setPicked] = useState<string | undefined>(
    linked ? requestKey(linked) : undefined,
  );
  const [sheet, setSheet] = useState<{ pr: number; title: string | null }>();
  const requests = actionRequests.data;
  const now = useCountdownNow(
    requests !== undefined && pendingRequests(requests).length > 0,
  );
  const decisions = useActionRequestDecisions(projectId, actionRequests.retry);
  const decide = (request: ActionRequestSummary, approve: boolean) =>
    decisions.ask(request, approve ? 'approve' : 'deny');

  return (
    <AsyncSection
      section={approvals}
      unavailable={{
        title: 'Approvals could not be loaded',
        stillWorks:
          'Nothing was decided. Fleet and the queue are still available.',
      }}
      empty={null}
      isEmpty={() => false}
    >
      {(view) => {
        const items = needsYouItems(view, requests);
        const selected =
          items.find((entry) => entry.key === picked) ?? items[0];
        const mismatch = mismatchSentence(
          view.mergeApproval,
          view.configMismatch,
        );
        const empty = emptyWaitingCopy(view.mergeApproval.agentdock);
        const settingsLink = (
          <Link
            href={approvalSettingsHref(projectId)}
            className={buttonClassName({ variant: 'glass', size: 'sm' })}
          >
            Open Settings
          </Link>
        );
        const pick = (entry: NeedsYouItem) => {
          setPicked(entry.key);
          if (phone && entry.kind === 'pr') {
            setSheet({ pr: entry.item.pr, title: entry.item.title });
          }
        };

        return (
          <div className="flex flex-col gap-8">
            {mismatch ? (
              <Banner
                tone="warn"
                title="Merge approval settings disagree"
                action={settingsLink}
              >
                {mismatch}
              </Banner>
            ) : null}
            {requests === undefined && actionRequests.error ? (
              <Banner
                tone="warn"
                title="Action requests could not be loaded"
                action={
                  <Button
                    variant="glass"
                    size="sm"
                    onClick={actionRequests.retry}
                  >
                    Try again
                  </Button>
                }
              >
                Nothing was decided. Pull request approvals are still listed.
              </Banner>
            ) : null}

            {items.length === 0 ? (
              <EmptyState
                title={empty.title}
                description={`${empty.description} When a Claude Code session asks to use a tool while you are away, or to start the orchestrator, the request waits here and in Telegram.`}
                action={view.mergeApproval.agentdock ? undefined : settingsLink}
              />
            ) : (
              <ListDetail
                listWidth={360}
                stickyList
                phoneView="list"
                listLabel="Waiting on you"
                list={
                  <Section
                    title="Waiting on you"
                    description="Nothing moves until a person answers."
                    pad="none"
                  >
                    <ul>
                      {items.map((entry) => (
                        <NeedsYouRow
                          key={entry.key}
                          entry={entry}
                          selected={entry.key === selected?.key}
                          now={now}
                          canOperate={canOperate}
                          busy={decisions.busy}
                          onPick={() => pick(entry)}
                          onDecide={decide}
                        />
                      ))}
                    </ul>
                  </Section>
                }
                detail={
                  phone || !selected ? undefined : (
                    <div className="rounded-lg surface-content p-4">
                      {selected.kind === 'pr' ? (
                        <ApprovalPane
                          key={selected.key}
                          projectId={projectId}
                          runnerName={runnerName}
                          pr={selected.item.pr}
                          title={selected.item.title}
                          canOperate={canOperate}
                          version={version}
                          onChanged={onApprovalsChanged}
                        />
                      ) : (
                        <RequestPane
                          request={selected.request}
                          now={now}
                          canOperate={canOperate}
                          busy={decisions.busy}
                          onDecide={decide}
                        />
                      )}
                    </div>
                  )
                }
              />
            )}

            <RecentMerges
              view={view}
              onOpen={(item) => setSheet({ pr: item.pr, title: item.title })}
            />
            {requests ? <RecentRequests rows={requests} /> : null}

            {decisions.dialogs}
            <ApprovalSheet
              side={phone ? 'bottom' : 'right'}
              projectId={projectId}
              runnerName={runnerName}
              pr={sheet?.pr}
              title={sheet?.title}
              canOperate={canOperate}
              version={version}
              onClose={() => setSheet(undefined)}
              onChanged={onApprovalsChanged}
            />
          </div>
        );
      }}
    </AsyncSection>
  );
}
