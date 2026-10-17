'use client';

import {
  ACTION_REQUEST_NOTE_MAX,
  type ActionRequestSummary,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Textarea } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
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
  KIND_LABEL,
  pendingRequests,
  prApproveArgs,
  recentRequests,
  requestTitle,
  resultMessage,
  STATUS_LABEL,
  STATUS_TONE,
  secondsLeft,
  toolUseArgs,
} from '../../lib/approvals/action-requests';
import { Time } from '../../lib/format/time';
import { useErrorToast } from '../../lib/section/use-error-toast';

type Decision = 'approve' | 'deny';

/** The countdown ticks once a second. */
const TICK_MS = 1_000;

function RequestCell({ request }: { request: ActionRequestSummary }) {
  const tool = toolUseArgs(request);
  const pr = prApproveArgs(request);
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
      {request.summary ? (
        <span className="line-clamp-3 break-words text-sm text-ink-2">
          {request.summary}
        </span>
      ) : null}
      {/* Redacted by the runner, still untrusted: shown as text. */}
      {tool?.input ? (
        <CodeBlock code={tool.input} wrap maxHeight={120} copy={false} />
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
function Countdown({ expiresAt, now }: { expiresAt: string; now: number }) {
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
 * The Approvals page's "Action requests" tab (spec 201 D18): what Claude Code
 * sessions asked a person to decide. Operators approve or deny; a viewer reads.
 * A `tool_use` approval only answers the waiting hook; the other kinds run as
 * the approver on the server.
 */
export function ActionRequestsPanel({
  projectId,
  rows,
  canOperate,
  onChanged,
}: {
  projectId: string;
  rows: ActionRequestSummary[];
  canOperate: boolean;
  onChanged: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [asking, setAsking] = useState<{
    request: ActionRequestSummary;
    decision: Decision;
  }>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const pending = pendingRequests(rows);
  const recent = recentRequests(rows);

  useEffect(() => {
    if (pending.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [pending.length]);

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
      // A refusal such as "already decided" leaves the list stale too.
      onChanged();
    }
  };

  const ask = (request: ActionRequestSummary, decision: Decision) => {
    // A tool answer is cheap and time-boxed (5 min): approving it is one click.
    if (decision === 'approve' && request.kind === 'tool_use') {
      void decide(request, decision, '');
      return;
    }
    setNote('');
    setAsking({ request, decision });
  };

  const verb = asking?.decision === 'approve' ? 'Approve' : 'Deny';

  return (
    <div className="flex flex-col gap-6">
      {pending.length === 0 ? (
        <EmptyState
          title="No action requests waiting"
          description="When a Claude Code session asks to use a tool while you are away, or to start the orchestrator, the request waits here and in Telegram."
        />
      ) : (
        <Table scroll>
          <TableHead>
            <TableRow>
              <TableCell head>Request</TableCell>
              <TableCell head>Asked</TableCell>
              <TableCell head>Expires in</TableCell>
              <TableCell head>
                <span className="sr-only">Decide</span>
              </TableCell>
            </TableRow>
          </TableHead>
          <tbody>
            {pending.map((request) => (
              <TableRow key={request.id}>
                <TableCell>
                  <RequestCell request={request} />
                </TableCell>
                <TableCell>
                  <Time value={request.createdAt} />
                </TableCell>
                <TableCell>
                  <Countdown expiresAt={request.expiresAt} now={now} />
                </TableCell>
                <TableCell>
                  {canOperate ? (
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="glass"
                        size="sm"
                        disabled={busy}
                        aria-label={`Deny: ${requestTitle(request)}`}
                        onClick={() => ask(request, 'deny')}
                      >
                        Deny
                      </Button>
                      <Button
                        variant="glass"
                        size="sm"
                        disabled={
                          busy || secondsLeft(request.expiresAt, now) === 0
                        }
                        aria-label={`Approve: ${requestTitle(request)}`}
                        onClick={() => ask(request, 'approve')}
                      >
                        Approve
                      </Button>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}

      {recent.length > 0 ? (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Recent requests" />
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
        </section>
      ) : null}

      <ConfirmDialog
        open={asking !== undefined}
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
    </div>
  );
}
