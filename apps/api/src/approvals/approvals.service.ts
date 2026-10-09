import {
  APPROVAL_DECIDED_LIVE_EVENT,
  APPROVALS_ERROR,
  APPROVALS_LIVE_EVENT,
  type ApprovalDecidedEvent,
  type ApprovalItemView,
  type ApprovalsLiveChange,
  type AuditAction,
  type AuditResult,
  CURRENT_APPROVAL_STATUSES,
  PR_INSPECTION_CACHE_MS,
  type Role,
} from '@agentdock/shared';
import {
  APPROVAL_NOTE_MAX_BYTES,
  type PrInspection,
} from '@agentdock/shared/protocol';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { type AuditContext, SYSTEM_ACTOR } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { projectNotFound } from '../projects';
import { ApprovalCommands } from './approval-commands';
import { ApprovalViews } from './approval-views';
import { approvalsError } from './approvals-error';
import {
  APPROVAL_ROW_INCLUDE,
  type ApprovalRow,
  userRef,
} from './approvals-mapper';

type Tx = Prisma.TransactionClient;

/** Who calls, as the route resolved them — or #22's Telegram buttons. */
export interface ApprovalsCaller {
  projectId: string;
  /** The caller's effective project role. */
  role: Role;
  ctx: AuditContext;
}

interface ProjectTarget {
  id: string;
  runnerId: string;
  rootPath: string;
}

type Decision =
  | { decision: 'approved'; headSha: string }
  | { decision: 'changes_requested'; headSha: string; note: string };

/** The system's own commands (D6 voiding) carry the least role that runs them. */
const SYSTEM_CALLER = {
  role: 'operator' as const,
  ctx: { actor: SYSTEM_ACTOR },
};

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** One writer of a project's approval rows at a time, across API instances. */
export const lockApprovals = (tx: Tx, projectId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`approvals:${projectId}`}))`;

/** The PR's current row: at most one is `waiting` or `approved` (spec 20 notes, Q3). */
export const currentRow = (
  db: Tx | PrismaService,
  projectId: string,
  prNumber: number,
): Promise<ApprovalRow | null> =>
  db.mergeApproval.findFirst({
    where: {
      projectId,
      prNumber,
      status: { in: [...CURRENT_APPROVAL_STATUSES] },
    },
    orderBy: { createdAt: 'desc' },
    include: APPROVAL_ROW_INCLUDE,
  });

/**
 * The approval decisions (spec 20 D5–D8, D10): approve, request changes, and
 * the void of an approval whose PR moved. Every decision is bound to the head
 * the person saw, re-read from GitHub uncached; every outcome is audited.
 * AgentDock never merges (ADR-0005) — it signals the orchestrator.
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);
  private readonly inspections = new Map<
    string,
    { at: number; value: PrInspection }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly live: LiveService,
    private readonly commands: ApprovalCommands,
    private readonly views: ApprovalViews,
  ) {}

  /**
   * `pr.inspect` (D4), reused for 60 s unless `fresh`. A head that is not the
   * one an approval was bound to voids it (D6).
   */
  async inspect(
    caller: ApprovalsCaller,
    pr: number,
    options: { fresh: boolean },
  ): Promise<PrInspection> {
    const project = await this.target(caller.projectId);
    const key = `${project.id}:${pr}`;
    const cached = this.inspections.get(key);
    if (
      !options.fresh &&
      cached &&
      Date.now() - cached.at < PR_INSPECTION_CACHE_MS
    ) {
      return cached.value;
    }
    const value = await this.commands.inspect(
      project.runnerId,
      { projectId: project.id, root: project.rootPath, pr },
      { role: caller.role, ctx: caller.ctx },
    );
    this.inspections.set(key, { at: Date.now(), value });
    if (value.state === 'open') {
      await this.voidIfMoved(project, pr, value.headSha);
    }
    return value;
  }

  approve(
    caller: ApprovalsCaller,
    pr: number,
    headSha: string,
  ): Promise<ApprovalItemView> {
    return this.decide(caller, pr, { decision: 'approved', headSha });
  }

  /** D7: a note is required, at most 4 KB; refused with 422 before anything is sent. */
  async requestChanges(
    caller: ApprovalsCaller,
    pr: number,
    headSha: string,
    note: string | undefined,
  ): Promise<ApprovalItemView> {
    if (note === undefined || note.trim().length === 0) {
      throw approvalsError(
        422,
        APPROVALS_ERROR.noteRequired,
        'Requesting changes needs a note for the worker',
      );
    }
    if (utf8Bytes(note) > APPROVAL_NOTE_MAX_BYTES) {
      throw approvalsError(
        422,
        APPROVALS_ERROR.noteTooLong,
        `The note must be at most ${APPROVAL_NOTE_MAX_BYTES} bytes`,
      );
    }
    return this.decide(caller, pr, {
      decision: 'changes_requested',
      headSha,
      note,
    });
  }

  /**
   * Re-reads the head of every PR in `prs` that has an approved row, as the
   * system, voiding those that moved. Never throws: a runner that cannot
   * answer leaves the approval for the next check — and the orchestrator's
   * own freshness rule (plugin#8 D3) refuses an approval older than the head.
   */
  async recheckHeads(projectId: string, prs: number[]): Promise<void> {
    for (const pr of prs) {
      try {
        await this.inspect({ projectId, ...SYSTEM_CALLER }, pr, {
          fresh: true,
        });
      } catch (error) {
        this.logger.warn(
          `head check of PR #${pr} on project ${projectId} failed: ${
            error instanceof HttpException
              ? JSON.stringify(error.getResponse())
              : String(error)
          }`,
        );
      }
    }
  }

  private async decide(
    caller: ApprovalsCaller,
    pr: number,
    decision: Decision,
  ): Promise<ApprovalItemView> {
    const project = await this.target(caller.projectId);
    const note =
      decision.decision === 'changes_requested' ? decision.note : null;
    const action: AuditAction =
      decision.decision === 'approved'
        ? 'approval.approve'
        : 'approval.request_changes';
    const record = (result: AuditResult, meta: object = {}) =>
      this.audit.record({
        ...caller.ctx,
        action,
        target: { type: 'pull_request', id: String(pr) },
        projectId: project.id,
        after: {
          pr,
          headSha: decision.headSha,
          decision: decision.decision,
          ...(note === null ? {} : { note }),
        },
        result,
        meta,
      });
    const refuse = async (error: HttpException): Promise<never> => {
      await record('denied', { reason: error.getResponse() });
      throw error;
    };

    const before = await currentRow(this.prisma, project.id, pr);
    if (!before) {
      const any = await this.prisma.mergeApproval.findFirst({
        where: { projectId: project.id, prNumber: pr },
        select: { id: true },
      });
      return refuse(
        any
          ? approvalsError(
              409,
              APPROVALS_ERROR.notWaiting,
              `PR #${pr} is not waiting for a decision`,
            )
          : approvalsError(
              404,
              APPROVALS_ERROR.approvalNotFound,
              `PR #${pr} is not in this project's approval queue`,
            ),
      );
    }
    if (
      before.status === 'approved' &&
      decision.decision === 'approved' &&
      before.headSha === decision.headSha
    ) {
      return refuse(
        approvalsError(
          409,
          APPROVALS_ERROR.notWaiting,
          `PR #${pr} is already approved at this head`,
        ),
      );
    }

    let inspection: PrInspection;
    try {
      inspection = await this.inspect(caller, pr, { fresh: true });
    } catch (error) {
      await record('error', { error: errorOf(error) });
      throw error;
    }
    if (inspection.state !== 'open') {
      return refuse(
        approvalsError(
          409,
          APPROVALS_ERROR.prNotOpen,
          `PR #${pr} is ${inspection.state}`,
        ),
      );
    }
    if (inspection.headSha !== decision.headSha) {
      return refuse(
        approvalsError(
          409,
          APPROVALS_ERROR.headMoved,
          `PR #${pr} has new commits since you looked; review the new head`,
          { headSha: inspection.headSha },
        ),
      );
    }

    const by = await this.decider(caller.ctx);
    const at = new Date();
    const args = {
      projectId: project.id,
      root: project.rootPath,
      pr,
      headSha: decision.headSha,
      by: by.label,
      at: at.toISOString(),
    };
    const options = { role: caller.role, ctx: caller.ctx };
    try {
      if (decision.decision === 'approved') {
        await this.commands.approve(project.runnerId, args, options);
      } else {
        await this.commands.requestChanges(
          project.runnerId,
          { ...args, note: decision.note },
          options,
        );
      }
    } catch (error) {
      await record('error', { error: errorOf(error) });
      throw error;
    }

    const row = await this.prisma.$transaction(async (tx) => {
      await lockApprovals(tx, project.id);
      // The row a void may have replaced since `before` was read.
      const current = (await currentRow(tx, project.id, pr)) ?? before;
      return tx.mergeApproval.update({
        where: { id: current.id },
        data: {
          status: decision.decision,
          headSha: decision.headSha,
          decidedById: by.userId,
          decidedAt: at,
          note,
        },
        include: APPROVAL_ROW_INCLUDE,
      });
    });
    await record('ok', { rowId: row.id });
    this.publish(project.id, {
      projectId: project.id,
      pr,
      headSha: decision.headSha,
      decision: decision.decision,
      by: userRef(row.decidedBy),
      at: at.toISOString(),
      note,
    });
    return this.views.view(project.id, row);
  }

  /**
   * D6: the PR's head is no longer the one its approval was bound to. The
   * approved row becomes `stale`, a new `waiting` row takes its place, the
   * signal is withdrawn, and the void is audited as the system's.
   */
  private async voidIfMoved(
    project: ProjectTarget,
    pr: number,
    headSha: string,
  ): Promise<void> {
    const voided = await this.prisma.$transaction(async (tx) => {
      await lockApprovals(tx, project.id);
      const row = await currentRow(tx, project.id, pr);
      if (row?.status !== 'approved' || row.headSha === headSha) return null;
      await tx.mergeApproval.update({
        where: { id: row.id },
        data: { status: 'stale' },
      });
      await tx.mergeApproval.create({
        data: {
          projectId: project.id,
          prNumber: pr,
          slot: row.slot,
          issue: row.issue,
          source: row.source,
          status: 'waiting',
          waitingSince: new Date(),
        },
      });
      return row;
    });
    if (!voided?.headSha) return;

    const at = new Date().toISOString();
    let signal: object = { written: true };
    try {
      await this.commands.voidApproval(
        project.runnerId,
        {
          projectId: project.id,
          root: project.rootPath,
          pr,
          headSha: voided.headSha,
          at,
        },
        SYSTEM_CALLER,
      );
    } catch (error) {
      signal = { written: false, error: errorOf(error) };
      this.logger.warn(
        `void of PR #${pr} on project ${project.id}: the signal was not withdrawn`,
      );
    }
    await this.audit.record({
      ...SYSTEM_CALLER.ctx,
      action: 'approval.void',
      target: { type: 'pull_request', id: String(pr) },
      projectId: project.id,
      before: {
        status: 'approved',
        decidedById: voided.decidedById,
        decidedAt: voided.decidedAt,
      },
      after: {
        pr,
        headSha: voided.headSha,
        newHeadSha: headSha,
        decision: 'stale',
      },
      result: 'ok',
      meta: { rowId: voided.id, signal },
    });
    this.publish(project.id, {
      projectId: project.id,
      pr,
      headSha: voided.headSha,
      decision: 'stale',
      by: null,
      at,
      note: null,
    });
  }

  /** D10: a refetch hint for the queue, and the decision for #21 and #22. */
  private publish(projectId: string, decided: ApprovalDecidedEvent): void {
    const topic = `project:${projectId}` as const;
    const change: ApprovalsLiveChange = { kind: 'approvals', projectId };
    this.live.publish(topic, APPROVALS_LIVE_EVENT, change);
    this.live.publish(topic, APPROVAL_DECIDED_LIVE_EVENT, decided);
  }

  private async target(projectId: string): Promise<ProjectTarget> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, runnerId: true, rootPath: true },
    });
    if (!project) throw projectNotFound();
    return project;
  }

  /** Who the signal names: the user's name, else email. */
  private async decider(
    ctx: AuditContext,
  ): Promise<{ userId: string | null; label: string }> {
    if (ctx.actor.type !== 'user') return { userId: null, label: 'AgentDock' };
    const user = await this.prisma.user.findUnique({
      where: { id: ctx.actor.userId },
      select: { id: true, name: true, email: true },
    });
    if (!user) return { userId: null, label: 'AgentDock' };
    return { userId: user.id, label: user.name?.trim() || user.email };
  }
}

const errorOf = (error: unknown): unknown =>
  error instanceof HttpException ? error.getResponse() : 'internal';
