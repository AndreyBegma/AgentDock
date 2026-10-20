'use client';

import {
  ACTION_REQUEST_NOTE_MAX,
  type ActionRequestSummary,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Textarea } from '@andrewbehma/glass-ui/field';
import { Section } from '@andrewbehma/glass-ui/section';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  describeActionRequestError,
  formatCountdown,
  issueQueueArgs,
  KIND_LABEL,
  prApproveArgs,
  recentRequests,
  requestTitle,
  resultMessage,
  STATUS_LABEL,
  STATUS_TONE,
  secondsLeft,
} from '../../lib/approvals/action-requests';
import {
  reviewToolUse,
  stepFor,
  toolUseConfirmable,
} from '../../lib/approvals/tool-use-review';
import { Time } from '../../lib/format/time';
import { useErrorToast } from '../../lib/section/use-error-toast';
import { RevealedInput, ToolUseDialogBody } from './tool-use-review';

export type Decision = 'approve' | 'deny';

/** The countdown ticks once a second. */
const TICK_MS = 1_000;

export function RequestCell({ request }: { request: ActionRequestSummary }) {
  const review = reviewToolUse(request);
  const pr = prApproveArgs(request);
  const issue = issueQueueArgs(request);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-medium">{requestTitle(request)}</span>
      <span className="text-xs text-ink-3">{KIND_LABEL[request.kind]}</span>
      {/* C-110: the head an approval binds to, as read when it was asked. */}
      {pr ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-ink-2">
          <span className="break-words">{pr.title}</span>
          <span className="text-ink-3">
            at <code className="font-mono">{pr.shortHead}</code>
          </span>
          <a
            href={pr.diffUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-ink"
          >
            View the diff
          </a>
        </span>
      ) : null}
      {/* C-112: the issue a session filed, to read before it is queued. */}
      {issue ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-ink-2">
          <span className="break-words">{issue.title}</span>
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-ink"
          >
            Read the issue
          </a>
        </span>
      ) : null}
      {request.summary ? (
        <span className="line-clamp-3 break-words text-sm text-ink-2">
          {request.summary}
        </span>
      ) : null}
      {/* Redacted by the runner, still untrusted: shown as text, odd characters marked. */}
      {review && review.segments.length > 0 ? (
        <RevealedInput segments={review.segments} className="max-h-32" />
      ) : null}
    </div>
  );
}

/** " at 0b6445a" after a `pr_approve` request's title: the head it was bound to. */
function HeadSuffix({ request }: { request: ActionRequestSummary }) {
  const pr = prApproveArgs(request);
  if (!pr) return null;
  return (
    <span className="text-ink-3">
      {' '}
      at <code className="font-mono">{pr.shortHead}</code>
    </span>
  );
}

/** Time left on a pending request; "Expired" while the next refetch is on its way. */
export function Countdown({
  expiresAt,
  now,
}: {
  expiresAt: string;
  now: number;
}) {
  const left = secondsLeft(expiresAt, now);
  return (
    <Badge
      tone={left === 0 ? 'neutral' : left < 60 ? 'danger' : 'warn'}
      label={formatCountdown(left)}
      className="num"
    />
  );
}

/**
 * Approving and denying action requests (spec 201 D18), for the Queue page's
 * Approvals tab (C-284): what Claude Code sessions asked a person to decide.
 * `ask` opens the right dialog, or decides at once; `dialogs` is rendered once
 * by the caller. A `tool_use` approval only answers the waiting hook; the
 * other kinds run as the approver on the server.
 */
export function useActionRequestDecisions(
  projectId: string,
  onChanged: () => void,
) {
  const [asking, setAsking] = useState<{
    request: ActionRequestSummary;
    decision: Decision;
  }>();
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const decide = async (
    request: ActionRequestSummary,
    decision: Decision,
    text: string,
  ) => {
    setBusy(true);
    try {
      const done = await api<ActionRequestSummary & { result?: unknown }>(
        `/projects/${projectId}/action-requests/${request.id}/${decision}`,
        { method: 'POST', body: text ? { note: text } : {} },
      );
      if (decision === 'deny') toast.success('Request denied');
      else if (done.status === 'failed') {
        const why = resultMessage(done.result);
        toast.error(`Approved, but it could not run${why ? `: ${why}` : '.'}`);
      } else toast.success('Request approved');
    } catch (err) {
      showError(describeActionRequestError(err));
    } finally {
      setBusy(false);
      setAsking(undefined);
      setNote('');
      setTyped('');
      // A refusal such as "already decided" leaves the list stale too.
      onChanged();
    }
  };

  const ask = (request: ActionRequestSummary, decision: Decision) => {
    // Denying a tool is one click; approving one is not, see the tool dialog.
    if (stepFor(request, decision) === 'decide') {
      void decide(request, decision, '');
      return;
    }
    setNote('');
    setTyped('');
    setAsking({ request, decision });
  };

  const toolAsk =
    asking?.decision === 'approve' && asking.request.kind === 'tool_use'
      ? asking.request
      : undefined;
  const toolReview = toolAsk ? reviewToolUse(toolAsk) : null;
  const verb = asking?.decision === 'approve' ? 'Approve' : 'Deny';

  const dialogs = (
    <>
      {/* C-115: a tool is approved only here, with its whole input in view. */}
      <DialogRoot
        open={toolAsk !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) setAsking(undefined);
        }}
      >
        <DialogContent
          title={toolReview?.title ?? 'Approve this tool call?'}
          dismissible={!busy}
          footer={
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setAsking(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant="solid"
                disabled={
                  busy || !toolReview || !toolUseConfirmable(toolReview, typed)
                }
                onClick={() => {
                  if (toolAsk) void decide(toolAsk, 'approve', '');
                }}
              >
                Approve
              </Button>
            </>
          }
        >
          {toolReview ? (
            <ToolUseDialogBody
              review={toolReview}
              typed={typed}
              onTyped={setTyped}
            />
          ) : (
            <p>
              This request’s input could not be read, so it cannot be approved.
            </p>
          )}
        </DialogContent>
      </DialogRoot>

      <ConfirmDialog
        open={asking !== undefined && toolAsk === undefined}
        onOpenChange={(open) => {
          if (!open) setAsking(undefined);
        }}
        title={
          asking
            ? `${verb} “${requestTitle(asking.request)}”?`
            : 'Decide this request?'
        }
        consequence={
          asking ? (
            <div className="flex flex-col gap-3">
              <p>
                {asking.decision === 'approve'
                  ? 'It runs now, as you: the budget gate and the audit log apply to you, not to the session.'
                  : asking.request.kind === 'issue_queue'
                    ? 'The issue stays open and unqueued; nothing is posted on it.'
                    : 'The session is told no, and the note below goes with it.'}
              </p>
              <Field label="Note (optional)" htmlFor="action-request-note">
                <Textarea
                  id="action-request-note"
                  value={note}
                  maxLength={ACTION_REQUEST_NOTE_MAX}
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
            </div>
          ) : null
        }
        verb={verb}
        tone={asking?.decision === 'deny' ? 'danger' : 'default'}
        busy={busy}
        onConfirm={() => {
          if (asking) void decide(asking.request, asking.decision, note.trim());
        }}
      />
    </>
  );

  return { ask, busy, dialogs };
}

/** The current time, ticking once a second while `active` (a countdown runs). */
export function useCountdownNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Decided and expired requests, newest first; nothing when there are none. */
export function RecentRequests({
  rows,
}: {
  rows: readonly ActionRequestSummary[];
}) {
  const recent = recentRequests(rows);
  if (recent.length === 0) return null;
  return (
    <Section title="Recent action requests" surface="none">
      <Table scroll>
        <TableHead>
          <TableRow>
            <TableCell head>Request</TableCell>
            <TableCell head>Outcome</TableCell>
            <TableCell head>When</TableCell>
            <TableCell head>Note</TableCell>
          </TableRow>
        </TableHead>
        <tbody>
          {recent.map((request) => (
            <TableRow key={request.id}>
              <TableCell>
                <span className="font-medium">{requestTitle(request)}</span>
                <HeadSuffix request={request} />
              </TableCell>
              <TableCell>
                <Badge
                  tone={STATUS_TONE[request.status]}
                  label={STATUS_LABEL[request.status]}
                />
              </TableCell>
              <TableCell>
                <Time value={request.decidedAt ?? request.expiresAt} />
              </TableCell>
              <TableCell>
                <span className="line-clamp-2 break-words">
                  {request.note ?? '—'}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </Table>
    </Section>
  );
}
