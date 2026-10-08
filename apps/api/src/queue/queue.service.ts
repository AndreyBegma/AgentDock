import {
  ALWAYS_ALLOWED_LABELS,
  type AuditResult,
  type CreateIssueResult,
  QUEUE_ERROR,
  type QueueRefreshResult,
  type Role,
  specGap,
} from '@agentdock/shared';
import { issueCreateArgsSchema } from '@agentdock/shared/protocol';
import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import type { CreateIssueDto } from './dto';
import { QueueCommands } from './queue-commands';
import { queueError } from './queue-error';
import { labelsOf, readyLabelOf } from './queue-inputs';

/** Who calls, as the route resolved them. */
export interface QueueCaller {
  projectId: string;
  role: Role;
  ctx: AuditContext;
}

/** The queue's writes: filing an issue (D7, D8) and asking for a poll. */
@Injectable()
export class QueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly commands: QueueCommands,
  ) {}

  /**
   * Files an issue through the runner. Refused with 422 — before anything is
   * sent — when `queue` is set and the body is not complete enough to
   * dispatch, or when a label is not one the repository uses. Audited either
   * way, with the issue number on success.
   */
  async createIssue(
    caller: QueueCaller,
    dto: CreateIssueDto,
  ): Promise<CreateIssueResult> {
    const { projectId } = caller;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        runnerId: true,
        readyLabelOverride: true,
        codeSentinelConfig: true,
      },
    });
    if (!project) throw projectNotFound();
    const labels = [...new Set(dto.labels.map((l) => l.trim()))];
    const record = (
      result: AuditResult,
      outcome: object = {},
      meta: object = {},
    ) =>
      this.audit.record({
        ...caller.ctx,
        action: 'issue.create',
        target: { type: 'project', id: projectId },
        projectId,
        after: { title: dto.title, labels, queue: dto.queue, ...outcome },
        result,
        meta,
      });

    const refused = await this.refusal(
      projectId,
      readyLabelOf(project),
      dto,
      labels,
    );
    if (refused) {
      await record('denied', {}, { reason: refused.getResponse() });
      throw refused;
    }

    const args = issueCreateArgsSchema.safeParse({
      projectId,
      title: dto.title,
      body: dto.body,
      labels,
      queue: dto.queue,
    });
    if (!args.success) {
      // What the DTO cannot see: the body's byte size, a blank title.
      throw new BadRequestException(
        args.error.issues.map((i) => `${i.path.join('.')} ${i.message}`),
      );
    }

    try {
      const created = await this.commands.createIssue(
        project.runnerId,
        args.data,
        { role: caller.role, ctx: caller.ctx },
      );
      await record('ok', created);
      return created;
    } catch (error) {
      await record(
        'error',
        {},
        {
          error:
            error instanceof HttpException ? error.getResponse() : 'internal',
        },
      );
      throw error;
    }
  }

  /** Asks the runner to poll the project's issues now. */
  async refresh(caller: QueueCaller): Promise<QueueRefreshResult> {
    const project = await this.prisma.project.findUnique({
      where: { id: caller.projectId },
      select: { runnerId: true },
    });
    if (!project) throw projectNotFound();
    return this.commands.refreshIssues(
      project.runnerId,
      { projectId: caller.projectId },
      { role: caller.role, ctx: caller.ctx },
    );
  }

  private async refusal(
    projectId: string,
    readyLabel: string,
    dto: CreateIssueDto,
    labels: string[],
  ): Promise<HttpException | null> {
    if (dto.queue) {
      const gap = specGap(dto.body, labels);
      if (gap === 'no_acceptance_criteria') {
        return queueError(
          422,
          QUEUE_ERROR.noAcceptanceCriteria,
          'A queued issue needs an `## Acceptance criteria` section with at least one `- [ ]` item (or `## Steps to reproduce` for a bug)',
        );
      }
      if (gap === 'no_parallel_plan') {
        return queueError(
          422,
          QUEUE_ERROR.noParallelPlan,
          'A queued XL or XXL issue needs a `## Parallel plan`',
        );
      }
    }
    const allowed = await this.allowedLabels(projectId, readyLabel);
    const refused = labels.filter((l) => !allowed.has(l.toLowerCase()));
    if (refused.length > 0) {
      return queueError(
        422,
        QUEUE_ERROR.labelNotAllowed,
        `Labels must be ones the repository already uses, and never the ready label: ${refused.join(', ')}`,
        { labels: refused },
      );
    }
    return null;
  }

  /**
   * D7: labels the repository's issues already carry, plus `enhancement` and
   * `bug` — never the ready label, which only `queue` may add, so the
   * completeness rule cannot be bypassed. Lower-cased: GitHub ignores case.
   */
  private async allowedLabels(
    projectId: string,
    readyLabel: string,
  ): Promise<Set<string>> {
    const rows = await this.prisma.issueCache.findMany({
      where: { projectId, kind: 'issue' },
      select: { labels: true },
    });
    const allowed = new Set<string>(ALWAYS_ALLOWED_LABELS);
    for (const row of rows) {
      for (const label of labelsOf({ labels: row.labels })) {
        allowed.add(label.toLowerCase());
      }
    }
    allowed.delete(readyLabel.toLowerCase());
    return allowed;
  }
}
