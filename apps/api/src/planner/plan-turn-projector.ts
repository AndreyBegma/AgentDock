import {
  asPlannerContractVersion,
  type CardDraft,
  type ClarifyOutput,
  type DecomposeOutput,
  type DesignOutput,
  type DiscussOutput,
  type GrillOutput,
  type IntakeOutput,
  isIntakeCard,
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
import type { Plan, PlanTask, PlanTurn, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { applyDesignOutput, settleDesign } from '../design/design-apply';
import { CARD_DESIGN_CONTRACT_VERSION } from '../design/design-prompt';
import {
  type DesignGate,
  type DesignTurnPlan,
  designTurnPlanOf,
  withDesign,
} from '../design/design-rules';
import {
  applySuggestions,
  cardDesignTaskKey,
  type DesignKey,
  designGates,
  previousFramesOf,
  stackDesignTaskKey,
} from '../design/design-store';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { CardDesignTurnService } from './card-design-turn.service';
import {
  afterGrill,
  type CurrentTask,
  draftOf,
  revisedTasks,
  type TaskDraft,
} from './plan-apply';
import { PlanCandidatesService } from './plan-candidates.service';
import { intakeTurnState } from './plan-intake';
import { inputOf, questionsOf } from './plan-mapper';
import { PlanStore } from './plan-store';
import { PlanTurnService } from './plan-turn.service';
import { StackDesignTurnService } from './stack-design-turn.service';

type Tx = Prisma.TransactionClient;

/** A plan's turn, with its plan. */
type PlanOwnedTurn = PlanTurn & {
  plan: Plan;
  planId: string;
  task: PlanTask | null;
};
/**
 * A design turn owned outside a plan — a board card's (#243 D2) or a stack's
 * (#480, ADR-0044) — and what its end needs of the owner.
 */
interface DesignHost {
  key: DesignKey;
  projectId: string;
  /** The `taskKey` the turn answers under. */
  taskKey: string;
  publish(): void;
  /** The next turn of the batch; false when it did not start. */
  chain(batch: DesignTurnPlan, authorId: string | null): Promise<boolean>;
}
type OwnedTurn =
  | { kind: 'plan'; turn: PlanOwnedTurn }
  | { kind: 'host'; turn: PlanTurn; host: DesignHost };

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
    private readonly cardTurns: CardDesignTurnService,
    private readonly stackTurns: StackDesignTurnService,
    private readonly candidates: PlanCandidatesService,
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

  /**
   * The turn, if it belongs to that owner, run and project on this runner.
   * ADR-0025: the event's `planId` is a plan's id, or — for a board card's
   * design turn (#243 D2) — the card's.
   */
  private async turnOf(
    runnerId: string,
    data: { turnId: string; planId: string; runId: string; projectId: string },
  ): Promise<OwnedTurn | null> {
    const owner = { projectId: data.projectId, project: { runnerId } };
    const turn = await this.prisma.planTurn.findFirst({
      where: {
        id: data.turnId,
        runId: data.runId,
        OR: [
          { planId: data.planId, plan: owner },
          { cardId: data.planId, card: owner },
          { stackId: data.planId, stack: owner },
        ],
      },
      include: { plan: true, task: true, card: true, stack: true },
    });
    if (turn?.plan && turn.planId !== null) {
      return {
        kind: 'plan',
        turn: { ...turn, plan: turn.plan, planId: turn.planId },
      };
    }
    if (turn?.card) {
      const card = turn.card;
      return {
        kind: 'host',
        turn,
        host: {
          key: { cardId: card.id },
          projectId: card.projectId,
          taskKey: cardDesignTaskKey(card.number),
          publish: () => this.store.publishCardDesign(card.projectId, card.id),
          chain: (batch, authorId) =>
            this.cardTurns.chain(card.id, batch, authorId),
        },
      };
    }
    if (turn?.stack) {
      const stack = turn.stack;
      return {
        kind: 'host',
        turn,
        host: {
          key: { stackId: stack.id },
          projectId: stack.projectId,
          taskKey: stackDesignTaskKey(stack.number),
          publish: () =>
            this.store.publishStackDesign(stack.projectId, stack.id),
          chain: (batch, authorId) =>
            this.stackTurns.chain(stack.id, batch, authorId),
        },
      };
    }
    this.logger.warn(
      `runner ${runnerId}: plan turn ${data.turnId} of project ${data.projectId} not found, skipped`,
    );
    return null;
  }

  /** `queued` → `running`. A terminal phase is settled by `finished`, which carries the result. */
  private async phaseChanged(
    runnerId: string,
    data: PlanTurnPhaseChangedData,
  ): Promise<void> {
    if (data.phase !== 'running') return;
    const owned = await this.turnOf(runnerId, data);
    if (!owned) return;
    const { turn } = owned;
    const updated = await this.prisma.planTurn.updateMany({
      where: { id: turn.id, phase: 'queued' },
      data: { phase: 'running' },
    });
    if (updated.count === 0) return;
    if (owned.kind === 'host') {
      owned.host.publish();
      await this.store.publishRun(owned.host.projectId, turn.runId);
    } else {
      await this.publish(owned.turn.plan, turn.runId);
    }
  }

  private async finished(
    runnerId: string,
    data: PlanTurnFinishedData,
  ): Promise<void> {
    const owned = await this.turnOf(runnerId, data);
    if (!owned) return;
    if (owned.kind === 'host') {
      await this.hostFinished(owned.turn, owned.host, data);
      return;
    }
    const { turn } = owned;
    const at = new Date(data.at);
    const resultText = data.resultText ?? null;
    let chain: Chain | null = null;
    /** #337: the intake's card was not English — asked once more. */
    let reask = false;

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
        await settleDesign(tx, { planId: turn.planId, taskKey: turn.task.key });
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
        : await this.parse(tx, turn, turn.action, resultText, designPlan);
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
        // #337 spec "Risks": a card in another language is asked again once.
        reask = settled && parsed?.error.reason === 'not_english';
        return settled;
      }
      if (
        parsed.output.action === 'design' &&
        'frames' in parsed &&
        Array.isArray(parsed.frames) &&
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
          {
            id: turn.id,
            owner: { planId: turn.planId, taskKey: turn.task.key },
          },
          designPlan,
          parsed.output,
          parsed.frames,
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
      if (parsed.output.action === 'discuss') {
        // #590: the reply is the stored output; only a new title is applied.
        await this.retitleDiscussion(tx, turn.planId, parsed.output);
        return true;
      }
      if (parsed.output.action === 'intake') {
        // #337 D4: a round waits for the person; #592: the card is a candidate.
        if (isIntakeCard(parsed.output)) {
          await this.writeCard(tx, turn.planId, parsed.output.cardDraft);
        }
        return true;
      }
      chain = await this.apply(tx, turn.plan, turn.task, parsed.output);
      return true;
    });
    if (!applied) return;
    await this.publish(turn.plan, turn.runId);
    if (reask) {
      await this.turns.chainIntake(
        turn.planId,
        inputOf(turn.input),
        turn.authorId,
      );
    }
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
        await settleDesign(this.prisma, {
          planId: turn.planId,
          taskKey: turn.task.key,
        });
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

  /**
   * #243 D2: a board card's design turn ended — or, #480, a stack's.
   * Validated against contract v2 like a plan task's design turn — a
   * violation fails the turn and stores no revision — then the next variant
   * of the batch starts, or the design rests. No write turn follows (D7).
   */
  private async hostFinished(
    turn: PlanTurn,
    host: DesignHost,
    data: PlanTurnFinishedData,
  ): Promise<void> {
    const at = new Date(data.at);
    const resultText = data.resultText ?? null;
    const owner = host.key;
    const designPlan = designTurnPlanOf(
      (
        await this.prisma.run.findUnique({
          where: { id: turn.runId },
          select: { args: true },
        })
      )?.args,
    );
    let next: DesignTurnPlan | null = null;
    const applied = await this.prisma.$transaction(async (tx) => {
      const fail = async (
        phase: 'failed' | 'cancelled',
        error: string,
      ): Promise<boolean> => {
        const settled = await this.store.settleTurn(
          turn.id,
          { phase, error, resultText, at },
          tx,
        );
        if (settled) await settleDesign(tx, owner);
        return settled;
      };
      if (data.phase !== 'succeeded') {
        return fail(data.phase, data.error ?? `the turn ended ${data.phase}`);
      }
      if (data.resultTruncated) {
        return fail(
          'failed',
          'contract_violation: result_truncated: the result was cut at the event size limit',
        );
      }
      if (!designPlan || turn.action !== 'design') {
        return fail(
          'failed',
          'contract_violation: invalid_shape: the design turn lost its variant; generate it again',
        );
      }
      const parsed = parsePlannerOutput(resultText ?? '', 'design', {
        contractVersion: CARD_DESIGN_CONTRACT_VERSION,
        taskKey: host.taskKey,
        variant: designPlan.variant,
        openCommentIds: designPlan.comments,
        previousFrames: await previousFramesOf(tx, owner, designPlan),
      });
      if (!parsed.ok) {
        return fail(
          'failed',
          `contract_violation: ${parsed.error.reason}: ${parsed.error.message}`,
        );
      }
      if (!('frames' in parsed) || parsed.frames.length === 0) {
        return fail(
          'failed',
          'contract_violation: invalid_shape: the design turn drew no mockup',
        );
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
      next = await applyDesignOutput(
        tx,
        { id: turn.id, owner },
        designPlan,
        parsed.output,
        parsed.frames,
      );
      return true;
    });
    if (!applied) return;
    host.publish();
    await this.store.publishRun(host.projectId, turn.runId);
    const batch = next as DesignTurnPlan | null;
    if (!batch) return;
    const started = await host.chain(batch, turn.authorId);
    if (!started) {
      await settleDesign(this.prisma, owner);
      host.publish();
    }
  }

  /**
   * #337 D6, #592 (ADR-0058): the intake's card, as a candidate the person
   * accepts or rejects in Drafts; the intake is `reviewing`. Nothing when
   * the intake was closed meanwhile.
   */
  private async writeCard(
    tx: Tx,
    planId: string,
    draft: CardDraft,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM plans WHERE id = ${planId} FOR UPDATE`;
    const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } });
    if (plan.mode !== 'card' || plan.status !== 'clarifying') return;
    await this.candidates.write(
      tx,
      plan.id,
      [{ title: draft.title, body: draft.body, kind: draft.kind }],
      null,
    );
  }

  /**
   * #590: a discussion turn that names the discussion retitles it; the
   * reply and the proposals stay in the turn's output. Nothing when the
   * discussion was discarded meanwhile.
   */
  private async retitleDiscussion(
    tx: Tx,
    planId: string,
    output: DiscussOutput,
  ): Promise<void> {
    if (!output.title) return;
    await tx.plan.updateMany({
      where: { id: planId, mode: 'discuss', status: 'clarifying' },
      data: { title: output.title },
    });
  }

  /** Validates against the contract with what only the API knows (D17). */
  private async parse(
    tx: Tx,
    turn: PlanOwnedTurn,
    action: PlanTurnAction,
    text: string | null,
    designPlan: DesignTurnPlan | null,
  ): Promise<PlannerParseResult<PlanTurnAction>> {
    const { plan, task } = turn;
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
          previousFrames: await previousFramesOf(
            tx,
            { planId: plan.id, taskKey: task.key },
            designPlan,
          ),
        });
      case 'clarify':
      case 'decompose':
      case 'discuss':
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
      case 'intake':
        // #337 D4: rounds asked before this turn, its Enough, the re-ask.
        return parsePlannerOutput(body, 'intake', {
          contractVersion,
          ...(await intakeTurnState(tx, plan.id, turn)),
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
      | DesignOutput
      | IntakeOutput
      | DiscussOutput,
  ): Promise<Chain | null> {
    // A design turn is applied by `applyDesignOutput`, an intake by
    // `writeCard`, a discussion turn by `retitleDiscussion`, before this is
    // reached.
    if (
      output.action === 'design' ||
      output.action === 'intake' ||
      output.action === 'discuss'
    ) {
      return null;
    }
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
