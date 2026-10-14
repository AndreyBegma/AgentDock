import {
  asPlannerContractVersion,
  type ClarifyOutput,
  type DecomposeOutput,
  type DesignOutput,
  type GrillOutput,
  isPlannedTask,
  type PlannerParseResult,
  type PlanTurnAction,
  parsePlannerOutput,
  type ReviseOutput,
  type WriteOutput,
} from '@agentdock/shared';
import {
  isPlanTurnEventType,
  type PlanTurnFinishedData,
  type PlanTurnPhaseChangedData,
  planTurnEventDataSchemas,
  type RunnerEvent,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Plan, PlanTask, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { applyDesignOutput, settleDesign } from '../design/design-apply';
import {
  type DesignGate,
  type DesignTurnPlan,
  designTurnPlanOf,
  withDesign,
} from '../design/design-rules';
import { applySuggestions, designGates } from '../design/design-store';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import {
  afterGrill,
  type CurrentTask,
  draftOf,
  revisedTasks,
  type TaskDraft,
} from './plan-apply';
import { questionsOf } from './plan-mapper';
import { PlanStore } from './plan-store';
import { PlanTurnService } from './plan-turn.service';

type Tx = Prisma.TransactionClient;

/** A turn the API starts once this one is applied (D7; spec 223 D4). */
type Chain =
  | { action: 'write' | 'decompose'; taskId: string | null }
  | { action: 'design'; taskId: string; design: DesignTurnPlan };

const taskData = (planId: string, version: number, draft: TaskDraft) => ({
  planId,
  planVersion: version,
  key: draft.key,
  kind: draft.kind,
  title: draft.title,
  summary: draft.summary,
  dependsOn: draft.dependsOn,
  status: draft.status,
  questions: draft.questions as Prisma.InputJsonValue,
  document: draft.document,
  frozen: draft.frozen,
  sessionId: draft.sessionId,
});

/** Spec 223 D1: a draft whose design holds it is `needs_design`. */
const gated = (
  draft: TaskDraft,
  design: DesignGate | undefined,
): TaskDraft => ({
  ...draft,
  status: withDesign(draft.status, design),
});

const asCurrent = (row: PlanTask): CurrentTask => ({
  key: row.key,
  kind: row.kind,
  title: row.title,
  summary: row.summary,
  dependsOn: row.dependsOn,
  status: row.status,
  questions: questionsOf(row.questions),
  document: row.document,
  frozen: row.frozen,
  sessionId: row.sessionId,
  rewriteComment: row.rewriteComment,
});

/**
 * Applies `plan_turn.phase_changed` and `plan_turn.finished` (D17). The
 * runner returns text; the API extracts the one `agentdock-plan` block and
 * validates it against the contract. A violation fails the turn
 * `contract_violation`, keeps `resultText` and changes no task. A turn is
 * touched only by the runner of its project, and `finished` lands once.
 */
@Injectable()
export class PlanTurnProjector implements RunnerEventSink, OnModuleInit {
  readonly name = 'planner';
  private readonly logger = new Logger(PlanTurnProjector.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly turns: PlanTurnService,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (!isPlanTurnEventType(event.type)) continue;
      const parsed = planTurnEventDataSchemas[event.type].safeParse(event.data);
      if (!parsed.success) {
        this.logger.warn(
          `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
        );
        continue;
      }
      if (event.type === 'plan_turn.phase_changed') {
        await this.phaseChanged(
          runnerId,
          parsed.data as PlanTurnPhaseChangedData,
        );
      } else {
        await this.finished(runnerId, parsed.data as PlanTurnFinishedData);
      }
    }
  }

  /** The turn, if it belongs to that plan, run and project on this runner. */
  private async turnOf(
    runnerId: string,
    data: { turnId: string; planId: string; runId: string; projectId: string },
  ) {
    const turn = await this.prisma.planTurn.findFirst({
      where: {
        id: data.turnId,
        planId: data.planId,
        runId: data.runId,
        plan: { projectId: data.projectId, project: { runnerId } },
      },
      include: { plan: true, task: true },
    });
    // ADR-0025: the `plan` filter above never matches a card's design turn;
    // #243 iB-api projects those. This narrows the now-nullable owner.
    if (!turn || turn.plan === null || turn.planId === null) {
      this.logger.warn(
        `runner ${runnerId}: plan turn ${data.turnId} of project ${data.projectId} not found, skipped`,
      );
      return null;
    }
    return { ...turn, plan: turn.plan, planId: turn.planId };
  }

  /** `queued` → `running`. A terminal phase is settled by `finished`, which carries the result. */
  private async phaseChanged(
    runnerId: string,
    data: PlanTurnPhaseChangedData,
  ): Promise<void> {
    if (data.phase !== 'running') return;
    const turn = await this.turnOf(runnerId, data);
    if (!turn) return;
    const updated = await this.prisma.planTurn.updateMany({
      where: { id: turn.id, phase: 'queued' },
      data: { phase: 'running' },
    });
    if (updated.count > 0) await this.publish(turn.plan, turn.runId);
  }

  private async finished(
    runnerId: string,
    data: PlanTurnFinishedData,
  ): Promise<void> {
    const turn = await this.turnOf(runnerId, data);
    if (!turn) return;
    const at = new Date(data.at);
    const resultText = data.resultText ?? null;
    let chain: Chain | null = null;

    const designPlan =
      turn.action === 'design'
        ? designTurnPlanOf(
            (
              await this.prisma.run.findUnique({
                where: { id: turn.runId },
                select: { args: true },
              })
            )?.args,
          )
        : null;
    // Spec 223: a design turn that draws nothing puts its design back to rest.
    const unsettle = async (tx: Tx) => {
      if (turn.action === 'design' && turn.task) {
        await settleDesign(tx, turn.planId, turn.task.key);
      }
    };

    const applied = await this.prisma.$transaction(async (tx) => {
      if (data.phase !== 'succeeded') {
        const settled = await this.store.settleTurn(
          turn.id,
          {
            phase: data.phase,
            error: data.error ?? `the turn ended ${data.phase}`,
            resultText,
            at,
          },
          tx,
        );
        if (settled) await unsettle(tx);
        return settled;
      }
      const parsed = data.resultTruncated
        ? null
        : await this.parse(
            tx,
            turn.plan,
            turn.task,
            turn.action,
            resultText,
            designPlan,
          );
      if (!parsed?.ok) {
        const why = parsed
          ? `${parsed.error.reason}: ${parsed.error.message}`
          : 'result_truncated: the result was cut at the event size limit';
        const settled = await this.store.settleTurn(
          turn.id,
          {
            phase: 'failed',
            error: `contract_violation: ${why}`,
            resultText,
            at,
          },
          tx,
        );
        if (settled) await unsettle(tx);
        return settled;
      }
      if (
        parsed.output.action === 'design' &&
        'html' in parsed &&
        typeof parsed.html === 'string' &&
        turn.task &&
        designPlan
      ) {
        const settled = await this.store.settleTurn(
          turn.id,
          {
            phase: 'succeeded',
            resultText,
            output: parsed.output as Prisma.InputJsonValue,
            at,
          },
          tx,
        );
        if (!settled) return false;
        const next = await applyDesignOutput(
          tx,
          { id: turn.id, planId: turn.planId, taskKey: turn.task.key },
          designPlan,
          parsed.output,
          parsed.html,
        );
        chain = next
          ? { action: 'design', taskId: turn.task.id, design: next }
          : null;
        return true;
      }
      const settled = await this.store.settleTurn(
        turn.id,
        {
          phase: 'succeeded',
          resultText,
          output: parsed.output as Prisma.InputJsonValue,
          at,
        },
        tx,
      );
      if (!settled) return false;
      chain = await this.apply(tx, turn.plan, turn.task, parsed.output);
      return true;
    });
    if (!applied) return;
    await this.publish(turn.plan, turn.runId);
    if (turn.action === 'design') {
      this.store.publishDesign(
        turn.plan.projectId,
        turn.planId,
        turn.task?.key ?? null,
      );
    }
    const next = chain as Chain | null;
    if (next?.action === 'design') {
      const started = await this.turns.chainDesign(
        turn.planId,
        next.taskId,
        next.design,
        turn.authorId,
      );
      if (!started && turn.task) {
        await settleDesign(this.prisma, turn.planId, turn.task.key);
        this.store.publishDesign(
          turn.plan.projectId,
          turn.planId,
          turn.task.key,
        );
      }
    } else if (next) {
      await this.turns.chain(
        turn.planId,
        next.action,
        next.taskId,
        turn.authorId,
      );
    }
  }

  /** Validates against the contract with what only the API knows (D17). */
  private async parse(
    tx: Tx,
    plan: Plan,
    task: PlanTask | null,
    action: PlanTurnAction,
    text: string | null,
    designPlan: DesignTurnPlan | null,
  ): Promise<PlannerParseResult<PlanTurnAction>> {
    const body = text ?? '';
    // D11: a plan's turns are validated against the version it was created with.
    const contractVersion = asPlannerContractVersion(plan.contractVersion);
    switch (action) {
      case 'design':
        if (!designPlan || !task) {
          return {
            ok: false,
            error: {
              code: 'contract_violation',
              reason: 'invalid_shape',
              message: 'the design turn lost its variant; generate it again',
            },
          };
        }
        return parsePlannerOutput(body, 'design', {
          contractVersion,
          taskKey: task.key,
          variant: designPlan.variant,
          openCommentIds: designPlan.comments,
        });
      case 'clarify':
      case 'decompose':
        return parsePlannerOutput(body, action, { contractVersion });
      case 'grill':
        return parsePlannerOutput(body, 'grill', {
          contractVersion,
          taskKey: task?.key ?? '',
        });
      case 'write':
        return parsePlannerOutput(body, 'write', {
          contractVersion,
          taskKey: task?.key ?? '',
          taskKind: task?.kind ?? 'feature',
        });
      case 'revise': {
        const approved = await tx.planTask.findMany({
          where: {
            planId: plan.id,
            planVersion: plan.version,
            status: 'approved',
          },
          select: { key: true },
        });
        return parsePlannerOutput(body, 'revise', {
          contractVersion,
          frozenKeys: approved.map((t) => t.key),
        });
      }
    }
  }

  /** Applies a valid output; returns the turn to chain, if any. */
  private async apply(
    tx: Tx,
    planRow: Plan,
    task: PlanTask | null,
    output:
      | ClarifyOutput
      | DecomposeOutput
      | GrillOutput
      | WriteOutput
      | ReviseOutput
      | DesignOutput,
  ): Promise<Chain | null> {
    // A design turn is applied by `applyDesignOutput` before this is reached.
    if (output.action === 'design') return null;
    // The turn may have been started on an older row; read the plan now.
    const plan = await tx.plan.findUniqueOrThrow({ where: { id: planRow.id } });
    switch (output.action) {
      case 'clarify':
        return output.done ? { action: 'decompose', taskId: null } : null;
      case 'decompose': {
        // Spec 223 D2: the suggestions first, so the statuses can read them.
        await applySuggestions(tx, plan, output.tasks);
        const designs = await designGates(tx, plan.id);
        await tx.planTask.deleteMany({
          where: { planId: plan.id, planVersion: plan.version },
        });
        await tx.planTask.createMany({
          data: output.tasks.map((t) =>
            taskData(
              plan.id,
              plan.version,
              gated(draftOf(t), designs.get(t.key)),
            ),
          ),
        });
        await tx.plan.update({
          where: { id: plan.id },
          data: { title: output.title, status: 'reviewing' },
        });
        return null;
      }
      case 'grill': {
        if (!task) return null;
        await applySuggestions(tx, plan, [
          { key: task.key, design: output.design },
        ]);
        const designs = await designGates(tx, plan.id);
        const next = afterGrill(output, designs.get(task.key));
        await tx.planTask.update({
          where: { id: task.id },
          data: {
            status: next.status,
            questions: next.questions as Prisma.InputJsonValue,
          },
        });
        return next.chainWrite ? { action: 'write', taskId: task.id } : null;
      }
      case 'write':
        if (!task) return null;
        await tx.planTask.update({
          where: { id: task.id },
          data: { document: output.document },
        });
        return null;
      case 'revise': {
        const current = await tx.planTask.findMany({
          where: { planId: plan.id, planVersion: plan.version },
        });
        const version = plan.version + 1;
        await applySuggestions(tx, plan, output.tasks.filter(isPlannedTask));
        const designs = await designGates(tx, plan.id);
        await tx.planTask.createMany({
          data: revisedTasks(current.map(asCurrent), output).map((d) =>
            taskData(plan.id, version, gated(d, designs.get(d.key))),
          ),
        });
        await tx.plan.update({ where: { id: plan.id }, data: { version } });
        return null;
      }
    }
  }

  private publish(plan: Plan, runId: string): Promise<void> {
    this.store.publish(plan.projectId, plan.id);
    return this.store.publishRun(plan.projectId, runId);
  }
}
