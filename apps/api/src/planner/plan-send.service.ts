import { PLANNER_ERROR, type PlannerSpecOutput } from '@agentdock/shared';
import {
  issueCreateArgsSchema,
  PLAN_QUEUE_ISSUES_MAX,
  planDocsBranch,
  planPublishSpecsArgsSchema,
} from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { Plan, PlanTask } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { readyLabelOf } from '../queue/queue-inputs';
import { callerOf, type PlanActor, PlanService } from './plan.service';
import { questionsOf } from './plan-mapper';
import {
  DESIGN_FALLBACK_DIR,
  dependencyOrder,
  designFilePath,
  docsPrIssueBody,
  documentOf,
  findCycle,
  ISSUE_PLACEHOLDER,
  rewriteDependsOn,
  type SendTask,
  specFilePath,
  THIS_ISSUE,
  withDesignPath,
} from './plan-send';
import { type PlanProject, PlanStore } from './plan-store';
import { PlannerCommands, plannerOutput } from './planner-commands';
import { PlannerFailure, plannerError } from './planner-error';
import { defaultSpecOutput, specDirOf } from './planner-instructions.service';

const asSendTask = (t: PlanTask): SendTask => ({
  key: t.key,
  kind: t.kind,
  title: t.title,
  summary: t.summary,
  dependsOn: t.dependsOn,
  questions: questionsOf(t.questions),
  document: t.document,
});

/** Spec 223 D16: what a task's approved design publishes. */
interface ApprovedDesignFile {
  variant: number;
  html: string;
}

/** The cuid's tail: `docs/plan-<shortid>` (D10). */
const shortIdOf = (planId: string): string =>
  planId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(-12);

const notSendable = (message: string) =>
  plannerError(409, PLANNER_ERROR.notSendable, message);

/**
 * Send to fleet (D8, D10): per plan, never per task. Files every approved
 * task as an issue in dependency order, rewrites `Depends on <key>` to real
 * numbers, publishes feature specifications as one docs pull request when
 * the project says so, and queues what may be queued now. Each issue number
 * is written to its task as soon as it exists, so a retry continues where
 * the last attempt stopped.
 */
@Injectable()
export class PlanSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly plans: PlanService,
    private readonly commands: PlannerCommands,
    private readonly audit: AuditService,
  ) {}

  async send(plan: Plan, actor: PlanActor): Promise<void> {
    if (plan.status === 'sent') return;
    this.store.assertOpen(plan);
    if (plan.status !== 'reviewing' && plan.status !== 'sending') {
      throw notSendable('The plan is not decomposed yet');
    }
    const active = await this.prisma.planTurn.count({
      where: { planId: plan.id, phase: { in: ['queued', 'running'] } },
    });
    if (active > 0) {
      throw plannerError(
        409,
        PLANNER_ERROR.turnInProgress,
        'A turn of this plan is queued or running',
      );
    }
    const tasks = await this.store.currentTasks(this.prisma, plan);
    const sending = tasks.filter(
      (t) => t.status === 'approved' || t.status === 'issued',
    );
    const talking = tasks.filter((t) => t.status === 'needs_talk');
    if (talking.length > 0) {
      throw notSendable(
        `Tasks still need a conversation: ${talking.map((t) => t.key).join(', ')}`,
      );
    }
    if (sending.length === 0) throw notSendable('No task is approved');
    const keys = new Set(sending.map((t) => t.key));
    for (const t of sending) {
      const missing = t.dependsOn.filter((d) => !keys.has(d));
      if (missing.length > 0) {
        throw notSendable(
          `Task ${t.key} depends on ${missing.join(', ')}, which is not approved`,
        );
      }
    }
    const cycle = findCycle(sending);
    if (cycle) {
      throw plannerError(
        409,
        PLANNER_ERROR.dependencyCycle,
        `dependsOn has a cycle: ${cycle.join(' → ')}`,
      );
    }

    const project = await this.store.project(plan.projectId);
    const { specOutput, specDir } = await this.publication(project);
    const designs = await this.approvedDesigns(plan.id);
    // D10, and spec 223 D16: a task with an approved design always goes
    // through the docs pull request, whatever the project's specOutput.
    const viaDocs = (t: Pick<PlanTask, 'key' | 'kind'>) =>
      (specOutput === 'docs_pr' && t.kind === 'feature') || designs.has(t.key);
    const publishes = sending.some(viaDocs);
    this.commands.assertReady(project.runnerId, 'issue.create');
    this.commands.assertReady(project.runnerId, 'plan.queue_issues');
    if (publishes) {
      this.commands.assertReady(project.runnerId, 'plan.publish_specs');
    }

    // D12: issues are visible to everyone with access to the repository.
    if (plan.visibility === 'private') {
      await this.prisma.plan.update({
        where: { id: plan.id },
        data: { visibility: 'project' },
      });
      await this.audit.record({
        ...actor.ctx,
        action: 'plan.shared',
        target: { type: 'plan', id: plan.id },
        projectId: plan.projectId,
        before: { visibility: 'private' },
        after: { visibility: 'project', reason: 'send' },
        result: 'ok',
      });
    }
    await this.prisma.plan.update({
      where: { id: plan.id },
      data: { status: 'sending' },
    });
    this.store.publish(plan.projectId, plan.id);

    const caller = callerOf(actor);
    const options = { role: caller.role, ctx: caller.ctx };
    const readyLabel = readyLabelOf(project);
    const branch = planDocsBranch(shortIdOf(plan.id));
    const byKey = new Map(sending.map((t) => [t.key, t]));
    const numbers = new Map<string, number>();
    for (const t of sending) {
      if (t.issueNumber !== null) numbers.set(t.key, t.issueNumber);
    }

    try {
      for (const key of dependencyOrder(sending)) {
        const task = byKey.get(key);
        if (!task || numbers.has(key)) continue;
        const send = asSendTask(task);
        const design = designs.get(key) ?? null;
        const body = rewriteDependsOn(
          viaDocs(task) && specDir
            ? docsPrIssueBody(send, specDir, branch, design?.variant ?? null)
            : design
              ? withDesignPath(
                  documentOf(send),
                  designFilePath(
                    specDir,
                    ISSUE_PLACEHOLDER,
                    task.title,
                    design.variant,
                  ),
                  designFilePath(
                    specDir,
                    THIS_ISSUE,
                    task.title,
                    design.variant,
                  ),
                )
              : documentOf(send),
          task.dependsOn,
          numbers,
        );
        const args = issueCreateArgsSchema.safeParse({
          projectId: plan.projectId,
          title: task.title,
          body,
          labels: [task.kind === 'bug' ? 'bug' : 'enhancement'],
          queue: false,
          readyLabel,
        });
        if (!args.success) {
          throw plannerError(
            400,
            PLANNER_ERROR.invalidArgs,
            `Task ${key}: ${z.prettifyError(args.error)}`,
          );
        }
        const created = plannerOutput(
          'issue.create',
          await this.commands.createIssue(project.runnerId, args.data, options),
        );
        numbers.set(key, created.number);
        await this.prisma.planTask.update({
          where: { id: task.id },
          data: {
            status: 'issued',
            issueNumber: created.number,
            issueUrl: created.url,
          },
        });
        this.store.publish(plan.projectId, plan.id);
      }

      // D10: what the docs pull request carries waits for its merge.
      const now = await this.store.currentTasks(this.prisma, plan);
      const queueNow = now.filter(
        (t) => t.issueNumber !== null && t.queuedAt === null && !viaDocs(t),
      );
      await this.queue(project, queueNow, readyLabel, options);

      let docsPr: { number: number; url: string } | null =
        plan.docsPrNumber !== null && plan.docsPrUrl !== null
          ? { number: plan.docsPrNumber, url: plan.docsPrUrl }
          : null;
      if (publishes && !docsPr) {
        docsPr = await this.publish(
          plan,
          project,
          now.filter(viaDocs),
          designs,
          { specDir, branch },
          options,
        );
      }

      await this.prisma.plan.update({
        where: { id: plan.id },
        data: { status: 'sent', sentAt: new Date() },
      });
      await this.plans.close(plan, caller);
      await this.audit.record({
        ...actor.ctx,
        action: 'plan.sent',
        target: { type: 'plan', id: plan.id },
        projectId: plan.projectId,
        after: {
          version: plan.version,
          specOutput,
          issues: [...numbers.values()],
          queued: queueNow.map((t) => t.issueNumber),
          docsPrNumber: docsPr?.number ?? null,
        },
        result: 'ok',
      });
      this.store.publish(plan.projectId, plan.id);
    } catch (error) {
      if (error instanceof PlannerFailure) {
        await this.audit.record({
          ...actor.ctx,
          action: 'plan.sent',
          target: { type: 'plan', id: plan.id },
          projectId: plan.projectId,
          after: { version: plan.version, issues: [...numbers.values()] },
          result: 'error',
          meta: { error: error.code, message: error.message },
        });
        this.store.publish(plan.projectId, plan.id);
      }
      throw error;
    }
  }

  /** D10 and Q4: `docs_pr` needs a repository-relative `specDir`. */
  private async publication(
    project: PlanProject,
  ): Promise<{ specOutput: PlannerSpecOutput; specDir: string | null }> {
    const settings = await this.prisma.plannerSettings.findUnique({
      where: { projectId: project.id },
      select: { specOutput: true },
    });
    const specDir = specDirOf(project.codeSentinelConfig);
    const specOutput = settings?.specOutput ?? defaultSpecOutput(specDir);
    if (specOutput === 'docs_pr' && !specDir) {
      throw plannerError(
        422,
        PLANNER_ERROR.invalidArgs,
        'docs_pr needs the project to have a specDir inside the repository',
      );
    }
    return { specOutput, specDir };
  }

  /** `plan.queue_issues` in batches of 50; `queuedAt` on each labelled task. */
  async queue(
    project: PlanProject,
    tasks: readonly PlanTask[],
    readyLabel: string,
    options: Parameters<PlannerCommands['send']>[3],
  ): Promise<number[]> {
    const labelled: number[] = [];
    for (let i = 0; i < tasks.length; i += PLAN_QUEUE_ISSUES_MAX) {
      const batch = tasks
        .slice(i, i + PLAN_QUEUE_ISSUES_MAX)
        .map((t) => t.issueNumber)
        .filter((n): n is number => n !== null);
      if (batch.length === 0) continue;
      const output = plannerOutput(
        'plan.queue_issues',
        await this.commands.send(
          project.runnerId,
          'plan.queue_issues',
          { projectId: project.id, numbers: batch, readyLabel },
          options,
        ),
      );
      labelled.push(...output.labelled);
    }
    if (labelled.length > 0) {
      await this.prisma.planTask.updateMany({
        where: {
          id: { in: tasks.map((t) => t.id) },
          issueNumber: { in: labelled },
        },
        data: { queuedAt: new Date() },
      });
    }
    return labelled;
  }

  /**
   * Spec 223 D16: the approved design of each task whose design is on — the
   * stored HTML, which never holds the pin helper.
   */
  private async approvedDesigns(
    planId: string,
  ): Promise<Map<string, ApprovedDesignFile>> {
    const rows = await this.prisma.taskDesign.findMany({
      where: {
        planId,
        needed: true,
        status: 'approved',
        approvedRevisionId: { not: null },
      },
      select: {
        taskKey: true,
        approvedRevision: { select: { variant: true, html: true } },
      },
    });
    return new Map(
      rows.flatMap((r) =>
        r.approvedRevision ? [[r.taskKey, r.approvedRevision] as const] : [],
      ),
    );
  }

  /**
   * D10: one docs pull request with a specification per task that goes
   * through it, named after its issue (with a `specDir`), and — spec 223
   * D16 — the approved design of each task that has one.
   */
  private async publish(
    plan: Plan,
    project: PlanProject,
    tasks: readonly PlanTask[],
    designs: ReadonlyMap<string, ApprovedDesignFile>,
    target: { specDir: string | null; branch: string },
    options: Parameters<PlannerCommands['send']>[3],
  ): Promise<{ number: number; url: string }> {
    const all = await this.store.currentTasks(this.prisma, plan);
    const numbers = new Map(
      all
        .filter((t) => t.issueNumber !== null)
        .map((t) => [t.key, t.issueNumber as number]),
    );
    const issued = tasks.filter((t) => t.issueNumber !== null);
    const designPath = (t: PlanTask, variant: number) =>
      designFilePath(target.specDir, t.issueNumber as number, t.title, variant);
    const entries = issued.map((t) => {
      const design = designs.get(t.key) ?? null;
      const spec = target.specDir
        ? {
            path: specFilePath(
              target.specDir,
              t.issueNumber as number,
              t.title,
            ),
            content: rewriteDependsOn(
              design
                ? withDesignPath(
                    documentOf(asSendTask(t)),
                    designFilePath(
                      target.specDir,
                      ISSUE_PLACEHOLDER,
                      t.title,
                      design.variant,
                    ),
                    designPath(t, design.variant),
                  )
                : documentOf(asSendTask(t)),
              t.dependsOn,
              numbers,
            ),
          }
        : null;
      const file = design
        ? { path: designPath(t, design.variant), content: design.html }
        : null;
      return { task: t, spec, design: file };
    });
    const files = entries.flatMap((e) =>
      [e.spec, e.design].filter((f) => f !== null),
    );
    const body = [
      `Specifications of the plan "${plan.title}" (version ${plan.version}).`,
      '',
      ...entries.map(({ task: t, spec, design }) =>
        [
          `- #${t.issueNumber} — ${t.title}`,
          spec ? `: \`${spec.path}\`` : '',
          design ? ` · design \`${design.path}\`` : '',
        ].join(''),
      ),
      '',
      'Their issues are queued when this pull request merges.',
      '',
    ].join('\n');
    const args = planPublishSpecsArgsSchema.safeParse({
      planId: plan.id,
      projectId: plan.projectId,
      root: project.rootPath,
      base: project.base,
      // Spec 223 "Open questions": designs of a project without a specDir live under docs/.
      specDir: target.specDir ?? DESIGN_FALLBACK_DIR,
      branch: target.branch,
      files,
      title: `docs: specifications of plan "${plan.title}"`.slice(0, 256),
      body,
    });
    if (!args.success) {
      throw plannerError(
        400,
        PLANNER_ERROR.invalidArgs,
        z.prettifyError(args.error),
      );
    }
    const output = plannerOutput(
      'plan.publish_specs',
      await this.commands.send(
        project.runnerId,
        'plan.publish_specs',
        args.data,
        options,
      ),
    );
    await this.prisma.plan.update({
      where: { id: plan.id },
      data: { docsPrNumber: output.prNumber, docsPrUrl: output.prUrl },
    });
    return { number: output.prNumber, url: output.prUrl };
  }
}
