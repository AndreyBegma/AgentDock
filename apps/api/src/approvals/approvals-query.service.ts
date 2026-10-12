import {
  APPROVALS_ERROR,
  APPROVALS_RECENT_LIMIT,
  type ApprovalDetail,
  type ApprovalInspectionError,
  type ApprovalStatus,
  type ApprovalsView,
  CURRENT_APPROVAL_STATUSES,
  configMergeApproval,
  mergeApprovalMismatch,
} from '@agentdock/shared';
import type { PrInspection } from '@agentdock/shared/protocol';
import { HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import { ApprovalViews } from './approval-views';
import { type ApprovalsCaller, ApprovalsService } from './approvals.service';
import { approvalsError } from './approvals-error';
import { APPROVAL_ROW_INCLUDE } from './approvals-mapper';

type ProjectConfig = {
  orchestrator?: Record<string, unknown>;
  error?: string;
} | null;

const CURRENT: readonly ApprovalStatus[] = CURRENT_APPROVAL_STATUSES;

/** The approval queue's reads (spec 20 "API"). */
@Injectable()
export class ApprovalsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly views: ApprovalViews,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * Current rows, oldest wait first, then recent decisions, newest first —
   * with D1's flags. `status` keeps rows of that status only.
   */
  async list(
    projectId: string,
    status?: ApprovalStatus,
  ): Promise<ApprovalsView> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { mergeApproval: true, codeSentinelConfig: true },
    });
    if (!project) throw projectNotFound();
    const config = project.codeSentinelConfig as ProjectConfig;

    const wantCurrent = !status || CURRENT.includes(status);
    const wantRecent = !status || !CURRENT.includes(status);
    const [current, recent] = await Promise.all([
      wantCurrent
        ? this.prisma.mergeApproval.findMany({
            where: {
              projectId,
              status: status ? status : { in: [...CURRENT_APPROVAL_STATUSES] },
            },
            orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
            include: APPROVAL_ROW_INCLUDE,
          })
        : [],
      wantRecent
        ? this.prisma.mergeApproval.findMany({
            where: {
              projectId,
              status: status
                ? status
                : { notIn: [...CURRENT_APPROVAL_STATUSES] },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: APPROVALS_RECENT_LIMIT,
            include: APPROVAL_ROW_INCLUDE,
          })
        : [],
    ]);

    return {
      mergeApproval: {
        agentdock: project.mergeApproval,
        config: configMergeApproval(config),
      },
      configMismatch: mergeApprovalMismatch({
        mergeApproval: project.mergeApproval,
        codeSentinelConfig: config,
      }),
      waiting: await this.views.views(projectId, current),
      recent: await this.views.views(projectId, recent),
    };
  }

  /**
   * The PR's current row (else its latest), its earlier rows, and the
   * `pr.inspect` result. A runner that cannot answer gives `inspection: null`
   * with the reason — never an empty diff that looks like a real one.
   */
  async detail(caller: ApprovalsCaller, pr: number): Promise<ApprovalDetail> {
    const rows = await this.prisma.mergeApproval.findMany({
      where: { projectId: caller.projectId, prNumber: pr },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: APPROVAL_ROW_INCLUDE,
    });
    if (rows.length === 0) {
      throw approvalsError(
        404,
        APPROVALS_ERROR.approvalNotFound,
        `PR #${pr} is not in this project's approval queue`,
      );
    }

    let inspection: PrInspection | null = null;
    let inspectionError: ApprovalInspectionError | null = null;
    try {
      inspection = await this.approvals.inspect(caller, pr, { fresh: false });
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      inspectionError = inspectionErrorOf(error);
    }

    // Re-read: the inspection may have voided an approval (D6).
    const fresh = inspection
      ? await this.prisma.mergeApproval.findMany({
          where: { projectId: caller.projectId, prNumber: pr },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: APPROVAL_ROW_INCLUDE,
        })
      : rows;
    const main = fresh.find((r) => CURRENT.includes(r.status)) ?? fresh[0];
    const [view, ...history] = await this.views.views(caller.projectId, [
      main,
      ...fresh.filter((r) => r.id !== main.id),
    ]);
    return { ...view, inspection, inspectionError, history };
  }
}

const inspectionErrorOf = (error: HttpException): ApprovalInspectionError => {
  const body = error.getResponse();
  if (typeof body === 'object' && body !== null) {
    const { error: code, message } = body as {
      error?: unknown;
      message?: unknown;
    };
    if (typeof code === 'string' && typeof message === 'string') {
      return { code, message };
    }
  }
  return { code: 'internal', message: error.message };
};
