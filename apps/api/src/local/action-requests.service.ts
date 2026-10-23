import {
  ACTION_REQUEST_PR_TITLE_MAX,
  ACTION_REQUEST_TTL_MS,
  type ActionRequestKind,
  type ActionRequestStatus,
  type ActionRequestSummary,
  actionRequestArgsSchemas,
  mayDecideActionRequest,
  prApproveBoundArgsSchema,
  type Role,
} from '@nautelle/shared';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { ActionRequest, Prisma } from '@prisma/client';
import { z } from 'zod';
import { type ApprovalsCaller, ApprovalsService } from '../approvals';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { ControlService } from '../control/control.service';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { oneLine } from '../notifications/event-mapping';
import { NotificationWriter } from '../notifications/notification-writer';
import { NotificationsService } from '../notifications/notifications.service';
import { QueueService } from '../queue/queue.service';
import {
  ACTION_REQUESTS_LIVE_EVENT,
  type ActionRequestsLiveChange,
  type ActionRequestView,
  actionRequestBody,
  actionRequestLink,
  actionRequestTitle,
  toActionRequestSummary,
  toActionRequestView,
} from './action-request-mapper';
import { httpErrorBody } from './local-error';

/** The error codes of the action-request routes. */
export const ACTION_REQUEST_ERROR = {
  notFound: 'not_found',
  invalidArgs: 'invalid_args',
  /** It was already decided, or it expired. */
  notPending: 'not_pending',
  /** A `pr_approve` for a PR that is merged or closed. */
  prNotOpen: 'pr_not_open',
  /** The requester may not approve their own non-`tool_use` request (D18). */
  selfApproval: 'self_approval',
} as const;
export type ActionRequestErrorCode =
  (typeof ACTION_REQUEST_ERROR)[keyof typeof ACTION_REQUEST_ERROR];

export const actionRequestError = (
  statusCode: number,
  error: ActionRequestErrorCode,
  message: string,
): HttpException =>
  new HttpException({ statusCode, error, message }, statusCode);

/** A read's view of a row: pending past its deadline is already expired. */
const asSeen = (row: ActionRequest, now: Date): ActionRequest =>
  row.status === 'pending' && row.expiresAt <= now
    ? { ...row, status: 'expired' }
    : row;

const notFound = () =>
  actionRequestError(
    404,
    ACTION_REQUEST_ERROR.notFound,
    'Action request not found',
  );

/** What a local request asks for (spec 201 D7 `action.request`). */
export interface NewActionRequest {
  projectId: string;
  runnerId: string;
  sessionId: string | null;
  /** The runner's local user. */
  requestedById: string | null;
  /** Their capped role on the project: what `pr.inspect` runs with. */
  requesterRole: Role;
  kind: ActionRequestKind;
  args: unknown;
  summary: string;
}

/** Who records the creation: the runner, for its local user (D8). */
export interface ActionRequestAuditor {
  ctx: AuditContext;
  meta?: object;
}

/** A person deciding, from the web or Telegram. */
export interface ActionRequestDecider {
  projectId: string;
  /** Their effective role on the project; at least operator. */
  role: Role;
  user: { id: string; email: string; role: Role };
  ctx: AuditContext;
  via: 'web' | 'telegram';
}

export type ActionRequestDecision = 'approve' | 'deny';

type Outcome =
  | { ok: true; result: Prisma.InputJsonObject }
  | { ok: false; result: { error: string; message: string } };

const DECIDED_STATUS: Record<ActionRequestDecision, ActionRequestStatus> = {
  approve: 'approved',
  deny: 'denied',
};

/**
 * Action requests (spec 201 D18): what a Claude Code session asks a person
 * for. Created by a local request, listed and decided in the web or in
 * Telegram, and — once approved — executed as the approver, so the budget
 * gate, the role checks and the audit log see the person who approved it.
 * `tool_use` is never executed: the waiting hook reads the decision.
 */
@Injectable()
export class ActionRequestsService {
  private readonly logger = new Logger(ActionRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly live: LiveService,
    private readonly writer: NotificationWriter,
    private readonly notifications: NotificationsService,
    private readonly control: ControlService,
    private readonly approvals: ApprovalsService,
    private readonly queue: QueueService,
  ) {}

  async create(
    input: NewActionRequest,
    auditor: ActionRequestAuditor,
  ): Promise<ActionRequestSummary> {
    const parsed = actionRequestArgsSchemas[input.kind].safeParse(input.args);
    if (!parsed.success) {
      throw actionRequestError(
        400,
        ACTION_REQUEST_ERROR.invalidArgs,
        `args: ${z.prettifyError(parsed.error)}`,
      );
    }
    if (input.kind === 'card_accept') {
      // #845: the kind's contract lands before its execution; nothing is
      // filed that no approval could carry out.
      throw actionRequestError(
        400,
        ACTION_REQUEST_ERROR.invalidArgs,
        'card_accept is not served yet',
      );
    }
    const args =
      input.kind === 'pr_approve'
        ? await this.bindPr(input, parsed.data as { pr: number }, auditor)
        : (parsed.data as Record<string, unknown>);
    const now = new Date();
    const { row, written } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.actionRequest.create({
        data: {
          projectId: input.projectId,
          runnerId: input.runnerId,
          sessionId: input.sessionId,
          requestedById: input.requestedById,
          kind: input.kind,
          summary: input.summary,
          args: args as Prisma.InputJsonObject,
          expiresAt: new Date(
            now.getTime() + ACTION_REQUEST_TTL_MS[input.kind],
          ),
          createdAt: now,
        },
      });
      // Only those who can decide it: viewers would get a button that refuses.
      const recipients = (
        await this.writer.projectRecipients(tx, input.projectId)
      ).filter((r) => r.role !== 'viewer');
      const written = await this.writer.write(
        tx,
        {
          kind: 'action.requested',
          projectId: input.projectId,
          runnerId: input.runnerId,
          slot: null,
          issue: null,
          title: actionRequestTitle(input.kind, args),
          body:
            oneLine(actionRequestBody(input.kind, args, input.summary), 300) ??
            '',
          link: actionRequestLink(input.projectId, row.id),
          eventId: null,
          at: now,
          fold: false,
        },
        recipients,
      );
      return { row, written };
    });
    await this.audit.record({
      ...auditor.ctx,
      action: 'action_request.created',
      target: { type: 'action_request', id: row.id },
      projectId: row.projectId,
      after: {
        kind: row.kind,
        args,
        summary: row.summary,
        sessionId: row.sessionId,
        expiresAt: row.expiresAt,
      },
      result: 'ok',
      ...(auditor.meta ? { meta: auditor.meta } : {}),
    });
    await this.notifications.publish(written);
    this.publish(row);
    return toActionRequestSummary(row);
  }

  /**
   * A `pr_approve` binds to the head `pr.inspect` reads now: the one the
   * person is shown and, on approval, the only one approved.
   */
  private async bindPr(
    input: NewActionRequest,
    { pr }: { pr: number },
    auditor: ActionRequestAuditor,
  ): Promise<Record<string, unknown>> {
    const inspection = await this.approvals.inspect(
      {
        projectId: input.projectId,
        role: input.requesterRole,
        ctx: auditor.ctx,
      },
      pr,
      { fresh: true },
    );
    if (inspection.state !== 'open') {
      throw actionRequestError(
        409,
        ACTION_REQUEST_ERROR.prNotOpen,
        `PR #${pr} is ${inspection.state}`,
      );
    }
    return prApproveBoundArgsSchema.parse({
      pr,
      headSha: inspection.headSha,
      title: inspection.title.slice(0, ACTION_REQUEST_PR_TITLE_MAX),
      url: inspection.url,
    });
  }

  /**
   * Reads never write: a pending row past `expiresAt` is shown as `expired`
   * here and moved by the every-minute sweep (`ActionRequestExpiryJob`).
   */
  async list(
    projectId: string,
    status?: ActionRequestStatus,
  ): Promise<ActionRequestView[]> {
    const now = new Date();
    const due = { status: 'pending' as const, expiresAt: { lte: now } };
    const where: Prisma.ActionRequestWhereInput =
      status === 'pending'
        ? { projectId, status, expiresAt: { gt: now } }
        : status === 'expired'
          ? { projectId, OR: [{ status }, due] }
          : { projectId, ...(status ? { status } : {}) };
    const rows = await this.prisma.actionRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => toActionRequestView(asSeen(row, now)));
  }

  /** `action.status`: one request of the project, a due one shown as expired. */
  async status(projectId: string, id: string): Promise<ActionRequestSummary> {
    const row = await this.prisma.actionRequest.findFirst({
      where: { id, projectId },
    });
    if (!row) throw notFound();
    return toActionRequestSummary(asSeen(row, new Date()));
  }

  /** The pending requests of a project, oldest first (`approvals.list`). */
  async pending(projectId: string): Promise<ActionRequestSummary[]> {
    const rows = await this.prisma.actionRequest.findMany({
      where: { projectId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    return rows.map(toActionRequestSummary);
  }

  /**
   * Approve or deny (D18). Operator on the project is the caller's check
   * (route guard, Telegram); here: the request is pending and unexpired, and
   * a requester approves their own non-`tool_use` request only as an admin.
   * An approval then executes as the approver; its outcome is the row's
   * `executed` or `failed` status and `result` — the decision stands either way.
   */
  async decide(
    decider: ActionRequestDecider,
    id: string,
    decision: ActionRequestDecision,
    note?: string,
  ): Promise<ActionRequestView> {
    const row = await this.prisma.actionRequest.findFirst({
      where: { id, projectId: decider.projectId },
    });
    if (!row) throw notFound();
    const record = (result: 'ok' | 'denied', meta: object = {}) =>
      this.audit.record({
        ...decider.ctx,
        action: 'action_request.decided',
        target: { type: 'action_request', id: row.id },
        projectId: row.projectId,
        after: {
          kind: row.kind,
          decision: DECIDED_STATUS[decision],
          ...(note ? { note } : {}),
        },
        result,
        meta: { ...meta, via: decider.via },
      });

    const now = new Date();
    if (row.status === 'pending' && row.expiresAt <= now) await this.expire();
    if (row.status !== 'pending' || row.expiresAt <= now) {
      const error = actionRequestError(
        409,
        ACTION_REQUEST_ERROR.notPending,
        row.expiresAt <= now && row.status === 'pending'
          ? 'The request expired'
          : `The request is already ${row.status}`,
      );
      await record('denied', { reason: ACTION_REQUEST_ERROR.notPending });
      throw error;
    }
    if (
      decision === 'approve' &&
      !mayDecideActionRequest({
        kind: row.kind,
        requestedById: row.requestedById,
        userId: decider.user.id,
        isAdmin: decider.user.role === 'admin',
      })
    ) {
      await record('denied', { reason: ACTION_REQUEST_ERROR.selfApproval });
      throw actionRequestError(
        403,
        ACTION_REQUEST_ERROR.selfApproval,
        'Only another operator or an admin can approve your own request',
      );
    }

    // Only one decision wins: the row moves only while it is still pending.
    const { count } = await this.prisma.actionRequest.updateMany({
      where: { id: row.id, status: 'pending' },
      data: {
        status: DECIDED_STATUS[decision],
        decidedById: decider.user.id,
        decidedAt: now,
        note: note ?? null,
      },
    });
    if (count === 0) {
      await record('denied', { reason: ACTION_REQUEST_ERROR.notPending });
      throw actionRequestError(
        409,
        ACTION_REQUEST_ERROR.notPending,
        'The request was decided meanwhile',
      );
    }
    await record('ok');
    let decided = await this.prisma.actionRequest.findUniqueOrThrow({
      where: { id: row.id },
    });
    this.publish(decided);

    if (decision === 'approve' && decided.kind !== 'tool_use') {
      decided = await this.execute(decided, decider);
      this.publish(decided);
    }
    return toActionRequestView(decided);
  }

  /** The every-minute sweep (D18): pending requests past `expiresAt` expire. */
  async expire(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.actionRequest.findMany({
      where: { status: 'pending', expiresAt: { lte: now } },
      select: { id: true },
      take: 500,
    });
    if (due.length === 0) return 0;
    const ids = due.map((d) => d.id);
    const { count } = await this.prisma.actionRequest.updateMany({
      where: { id: { in: ids }, status: 'pending' },
      data: { status: 'expired' },
    });
    const expired = await this.prisma.actionRequest.findMany({
      where: { id: { in: ids }, status: 'expired' },
    });
    for (const row of expired) this.publish(row);
    return count;
  }

  /** Runs an approved request as `decider`; the row ends executed or failed. */
  private async execute(
    row: ActionRequest,
    decider: ActionRequestDecider,
  ): Promise<ActionRequest> {
    const outcome = await this.run(row, decider);
    const updated = await this.prisma.actionRequest.update({
      where: { id: row.id },
      data: {
        status: outcome.ok ? 'executed' : 'failed',
        result: outcome.result,
      },
    });
    await this.audit.record({
      ...decider.ctx,
      action: 'action_request.executed',
      target: { type: 'action_request', id: row.id },
      projectId: row.projectId,
      after: { kind: row.kind, args: row.args, result: outcome.result },
      result: outcome.ok ? 'ok' : 'error',
      meta: { via: decider.via },
    });
    return updated;
  }

  private async run(
    row: ActionRequest,
    decider: ActionRequestDecider,
  ): Promise<Outcome> {
    const caller = {
      projectId: row.projectId,
      role: decider.role,
      user: { id: decider.user.id, email: decider.user.email },
      ctx: decider.ctx,
    };
    try {
      switch (row.kind) {
        case 'orchestrator_start': {
          const args = actionRequestArgsSchemas.orchestrator_start.parse(
            row.args,
          );
          const run = await this.control.start(caller, { mode: args.mode });
          return {
            ok: true,
            result: { commandRunId: run.id, status: run.status },
          };
        }
        case 'orchestrator_stop': {
          const run = await this.control.stop(caller);
          return {
            ok: true,
            result: { commandRunId: run.id, status: run.status },
          };
        }
        case 'pr_approve': {
          const bound = prApproveBoundArgsSchema.safeParse(row.args);
          if (!bound.success) {
            // Created before requests were bound to a head: nothing to approve.
            return {
              ok: false,
              result: {
                error: ACTION_REQUEST_ERROR.invalidArgs,
                message:
                  'The request names no head; ask for the approval again',
              },
            };
          }
          const { pr, headSha } = bound.data;
          const approvalsCaller: ApprovalsCaller = {
            projectId: row.projectId,
            role: decider.role,
            ctx: decider.ctx,
          };
          // Only the head the approver was shown; a moved head is refused
          // with `head_moved` and approves nothing.
          await this.approvals.approve(approvalsCaller, pr, headSha);
          return { ok: true, result: { pr, headSha } };
        }
        case 'issue_queue': {
          // C-112: the ready label, through the queue, as the approver.
          const { issue } = actionRequestArgsSchemas.issue_queue.parse(
            row.args,
          );
          await this.queue.queueIssue(
            {
              projectId: row.projectId,
              role: decider.role,
              ctx: decider.ctx,
              meta: { actionRequestId: row.id, via: decider.via },
            },
            issue,
          );
          return { ok: true, result: { issue } };
        }
        case 'tool_use':
          return { ok: true, result: {} };
        case 'card_accept':
          // #845: never created yet (see `create`).
          return {
            ok: false,
            result: {
              error: ACTION_REQUEST_ERROR.invalidArgs,
              message: 'card_accept is not served yet',
            },
          };
      }
    } catch (error) {
      if (error instanceof HttpException) {
        const { code, message } = httpErrorBody(error);
        return {
          ok: false,
          result: { error: code ?? `http_${error.getStatus()}`, message },
        };
      }
      this.logger.error(
        `action request ${row.id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        ok: false,
        result: { error: 'internal', message: 'internal error' },
      };
    }
  }

  private publish(row: ActionRequest): void {
    const change: ActionRequestsLiveChange = {
      kind: 'action_requests',
      projectId: row.projectId,
      id: row.id,
      status: row.status,
    };
    try {
      this.live.publish(
        `project:${row.projectId}`,
        ACTION_REQUESTS_LIVE_EVENT,
        change,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `${ACTION_REQUESTS_LIVE_EVENT} not published: ${reason}`,
      );
    }
  }
}
