import { randomUUID } from 'node:crypto';
import {
  asPlannerContractVersion,
  attachmentWorktreePath,
  checkRoundAnswers,
  intakeMustGenerate,
  PLANNER_ERROR,
  PLANNER_INTAKE_MAX_ROUNDS,
  type PlanQuestion,
  type PlanTurnAction,
  type PlanTurnInput,
  type Role,
  textAnswerField,
  withRecommendations,
} from '@agentdock/shared';
import {
  PLAN_TURN_DEFAULT_TIMEOUT_SEC,
  type PlanTurnArgs,
  type PlanTurnSession,
  planTurnArgsSchema,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Plan, PlanTask, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { SYSTEM_ACTOR, systemActorFor } from '../audit/audit.types';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import type { DesignTurnPlan } from '../design/design-rules';
import { installedOf } from '../design/design-store';
import { TextNormalizer } from '../text/text-normalizer';
import { TokenSaverService } from '../token-saver/token-saver.service';
import { TALKABLE_STATUSES } from './plan-apply';
import {
  intakeRound,
  intakeTurnState,
  readCardInstructions,
  runnerTakesPlanAttachments,
} from './plan-intake';
import { questionsOf } from './plan-mapper';
import { assemblePrompt } from './plan-prompt';
import { PlanStore } from './plan-store';
import { designPromptParts, retriedDesign } from './plan-turn-design';
import { PlannerCommands, plannerOutput } from './planner-commands';
import { PlannerFailure, plannerError } from './planner-error';

/** Who acts: a person on a route, or the system chaining a turn for its author. */
export interface PlanCaller {
  /** The person the turn runs for; their budget counts it (#28 D3). */
  userId: string | null;
  role: Role;
  ctx: AuditContext;
}

interface TurnSpec {
  action: PlanTurnAction;
  task: PlanTask | null;
  input: PlanTurnInput;
  /** Spec 223: what a design turn draws; kept in `runs.args.design`. */
  design?: DesignTurnPlan;
  /** #271: the input is the person's new words (not a retry's copy). */
  normalize?: boolean;
  /** #337 D10: pending uploads the turn claims onto its plan, checked already. */
  claim?: readonly string[];
}

/**
 * #337 D3: answers fit the round they answer — their own options, one option
 * for a single-choice question; 400 otherwise. An intake (`strict`) also
 * refuses a question it never asked. A clarify or grill turn keeps taking an
 * answer to a question outside its round, as it always has: the prompt
 * marks it "not in the current round".
 */
const assertAnswers = (
  round: readonly PlanQuestion[],
  input: PlanTurnInput,
  strict = false,
): void => {
  if (!input.answers?.length) return;
  const asked = new Set(round.map((q) => q.id));
  const answers = strict
    ? input.answers
    : input.answers.filter((a) => asked.has(a.questionId));
  const check = checkRoundAnswers(round, answers);
  if (!check.ok) {
    throw plannerError(400, PLANNER_ERROR.invalidArgs, check.message);
  }
};

/** #337 D3, D10, #409: the inputs only a card intake takes. */
const intakeOnly = (input: PlanTurnInput): boolean =>
  input.generate !== undefined ||
  input.keepOne !== undefined ||
  input.attachmentIds !== undefined;

const turnInProgress = () =>
  plannerError(
    409,
    PLANNER_ERROR.turnInProgress,
    'A turn of this plan is queued or running',
  );

/** A turn whose session exists on the runner: it produced output, or succeeded. */
const sessionStarted: Prisma.PlanTurnWhereInput = {
  OR: [{ phase: 'succeeded' }, { resultText: { not: null } }],
};

const ACTIVE = ['queued', 'running'] as const;

/**
 * Plan turns (D3, D7, D14, D16). A turn is a `runs` row of kind `plan` and a
 * `plan_turns` row; the runner runs `claude -p` once and reports the result
 * as `plan_turn.*` events, which `PlanTurnProjector` applies. One turn per
 * plan at a time.
 */
@Injectable()
export class PlanTurnService {
  private readonly logger = new Logger(PlanTurnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly commands: PlannerCommands,
    private readonly audit: AuditService,
    private readonly text: TextNormalizer,
    private readonly attachments: AttachmentsService,
    private readonly tokenSaver: TokenSaverService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /**
   * `POST …/turns`: the next plan-level round — clarify, or decompose when
   * that failed; a card plan's next intake turn (#337 D1).
   */
  async planTurn(
    plan: Plan,
    input: PlanTurnInput,
    caller: PlanCaller,
  ): Promise<string> {
    this.store.assertOpen(plan);
    if (plan.mode === 'card') return this.intakeTurn(plan, input, caller);
    if (plan.mode === 'discuss') {
      return this.discussTurn(plan, input, caller);
    }
    if (intakeOnly(input)) {
      throw plannerError(
        409,
        PLANNER_ERROR.wrongMode,
        'Enough — generate, Keep one card and attachments belong to a card intake',
      );
    }
    let action: PlanTurnAction;
    if (plan.status === 'clarifying') {
      assertAnswers(await this.store.planRound(plan.id), input);
      action = 'clarify';
    } else if (
      plan.status === 'drafting' &&
      (await this.store.currentTasks(this.prisma, plan)).length === 0
    ) {
      action = 'decompose';
    } else {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        'The plan is decomposed: talk a task through, or revise the plan',
      );
    }
    return this.run(
      plan,
      { action, task: null, input, normalize: true },
      caller,
    );
  }

  /**
   * #337 D3, D4, D10: an intake turn answers the open round, sends a message,
   * or says Enough — generate, which fills every unanswered question with its
   * recommendation. Files that come with it join the plan's. The person's
   * words are kept as typed (D5): no normalization.
   */
  private async intakeTurn(
    plan: Plan,
    input: PlanTurnInput,
    caller: PlanCaller,
  ): Promise<string> {
    if (plan.status !== 'clarifying') {
      throw plannerError(
        409,
        PLANNER_ERROR.planClosed,
        `The intake is ${plan.status}`,
      );
    }
    const round = await intakeRound(this.prisma, plan.id);
    assertAnswers(round, input, true);
    const answers =
      input.generate === true
        ? withRecommendations(round, input.answers ?? [])
        : input.answers;
    const { attachmentIds, ...rest } = input;
    const claim = attachmentIds ?? [];
    await this.attachments.assertPlanClaimable(
      plan.projectId,
      plan.id,
      claim,
      caller,
    );
    return this.run(
      plan,
      {
        action: 'intake',
        task: null,
        input: {
          ...rest,
          ...(answers && answers.length > 0 ? { answers } : {}),
          ...(claim.length > 0 ? { attachmentIds: claim } : {}),
        },
        claim,
      },
      caller,
    );
  }

  /**
   * #590 (ADR-0056): a discussion turn answers the person's message — any
   * number of them, none required to end in a card. The first turn, started
   * with the discussion, answers its opening (the brief) and takes no
   * message; every later one needs one. Answers, Enough, Keep one card and
   * files belong to an intake. The words are kept as typed: the model
   * replies in the person's language.
   */
  private async discussTurn(
    plan: Plan,
    input: PlanTurnInput,
    caller: PlanCaller,
  ): Promise<string> {
    if (intakeOnly(input) || input.answers !== undefined) {
      throw plannerError(
        409,
        PLANNER_ERROR.wrongMode,
        'A discussion takes messages only',
      );
    }
    const asked = await this.prisma.planTurn.count({
      where: { planId: plan.id },
    });
    if (asked > 0 && !input.message) {
      throw plannerError(
        400,
        PLANNER_ERROR.invalidArgs,
        'A discussion turn needs a message',
      );
    }
    return this.run(
      plan,
      {
        action: 'discuss',
        task: null,
        input: input.message ? { message: input.message } : {},
      },
      caller,
    );
  }

  /**
   * #337 spec "Risks": a card written in another language is asked again
   * once, with the same input; the next turn's card is taken as it is.
   */
  async chainIntake(
    planId: string,
    input: PlanTurnInput,
    authorId: string | null,
  ): Promise<void> {
    try {
      const plan = await this.prisma.plan.findUniqueOrThrow({
        where: { id: planId },
      });
      const { attachmentIds: _claimed, ...again } = input;
      await this.run(
        plan,
        { action: 'intake', task: null, input: again },
        {
          userId: authorId,
          role: 'operator',
          ctx: { actor: authorId ? systemActorFor(authorId) : SYSTEM_ACTOR },
        },
      );
    } catch (error) {
      this.logger.warn(
        `plan ${planId}: intake re-ask not started: ${(error as Error).message}`,
      );
    }
  }

  /** `POST …/tasks/:key/turns`: a grill round of one task (D7). */
  async taskTurn(
    plan: Plan,
    key: string,
    input: PlanTurnInput,
    caller: PlanCaller,
  ): Promise<string> {
    this.store.assertOpen(plan);
    if (intakeOnly(input)) {
      throw plannerError(
        409,
        PLANNER_ERROR.wrongMode,
        'Enough — generate, Keep one card and attachments belong to a card intake',
      );
    }
    const task = await this.store.task(plan, key);
    assertAnswers(questionsOf(task.questions), input);
    if (!TALKABLE_STATUSES.includes(task.status)) {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        `Task ${key} is ${task.status}; ask for a rewrite to talk it through again`,
      );
    }
    return this.run(
      plan,
      { action: 'grill', task, input, normalize: true },
      caller,
    );
  }

  /** D9: one plan-level turn with every rewrite comment. */
  async revise(plan: Plan, caller: PlanCaller): Promise<string> {
    this.store.assertOpen(plan);
    const tasks = await this.store.currentTasks(this.prisma, plan);
    const comments = tasks.filter((t) => t.status === 'rewrite_requested');
    if (plan.status !== 'reviewing' || comments.length === 0) {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        'Revise needs a decomposed plan with a rewrite requested',
      );
    }
    const turnId = await this.run(
      plan,
      { action: 'revise', task: null, input: {} },
      caller,
    );
    await this.audit.record({
      ...caller.ctx,
      action: 'plan.revised',
      target: { type: 'plan', id: plan.id },
      projectId: plan.projectId,
      after: {
        fromVersion: plan.version,
        rewrites: comments.map((t) => t.key),
        turnId,
      },
      result: 'ok',
    });
    return turnId;
  }

  /** A failed turn again: its action, input and scope; no audit of its own. */
  async retry(plan: Plan, turnId: string, caller: PlanCaller): Promise<string> {
    this.store.assertOpen(plan);
    const turn = await this.prisma.planTurn.findFirst({
      where: { id: turnId, planId: plan.id },
      include: { task: { select: { key: true } } },
    });
    if (!turn) {
      throw plannerError(404, PLANNER_ERROR.notFound, 'Turn not found');
    }
    if (turn.phase !== 'failed') {
      throw plannerError(
        409,
        PLANNER_ERROR.turnNotFailed,
        `The turn is ${turn.phase}; only a failed turn is retried`,
      );
    }
    const task = turn.task ? await this.store.task(plan, turn.task.key) : null;
    const input = (turn.input ?? {}) as PlanTurnInput;
    const design =
      turn.action === 'design'
        ? await retriedDesign(this.prisma, plan.id, turn.runId, task)
        : undefined;
    return this.run(plan, { action: turn.action, task, input, design }, caller);
  }

  /**
   * Spec 223 D4, D10: one design turn — one variant of one task, in the
   * task's fork session (D8). The variants of a batch run one after another:
   * `PlanTurnProjector` starts the next when one is drawn.
   */
  designTurn(
    plan: Plan,
    task: PlanTask,
    design: DesignTurnPlan,
    caller: PlanCaller,
  ): Promise<string> {
    this.store.assertOpen(plan);
    return this.run(
      plan,
      { action: 'design', task, input: {}, design },
      caller,
    );
  }

  /**
   * The next design turn of a batch, or the first after a profile build
   * (D13), for the person who asked for it. False when it did not start —
   * the caller settles the design.
   */
  async chainDesign(
    planId: string,
    taskId: string,
    design: DesignTurnPlan,
    authorId: string | null,
  ): Promise<boolean> {
    try {
      const plan = await this.prisma.plan.findUniqueOrThrow({
        where: { id: planId },
      });
      const task = await this.prisma.planTask.findUniqueOrThrow({
        where: { id: taskId },
      });
      await this.designTurn(plan, task, design, {
        userId: authorId,
        role: 'operator',
        ctx: { actor: authorId ? systemActorFor(authorId) : SYSTEM_ACTOR },
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `plan ${planId}: design turn of variant ${design.variant} not started: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /** Kills the turn's session; the runner reports `cancelled`. */
  async cancel(plan: Plan, turnId: string, caller: PlanCaller): Promise<void> {
    const turn = await this.prisma.planTurn.findFirst({
      where: { id: turnId, planId: plan.id },
      select: { phase: true },
    });
    if (!turn) {
      throw plannerError(404, PLANNER_ERROR.notFound, 'Turn not found');
    }
    if (!(ACTIVE as readonly string[]).includes(turn.phase)) {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        `The turn already ended ${turn.phase}`,
      );
    }
    const project = await this.store.project(plan.projectId);
    plannerOutput(
      'plan.cancel',
      await this.commands.send(
        project.runnerId,
        'plan.cancel',
        { planId: plan.id, turnId },
        { role: caller.role, ctx: caller.ctx },
      ),
    );
  }

  /**
   * A turn the API starts on its own (D7): `write` after a grill is done,
   * `decompose` after clarify is done. It runs for the author of the turn
   * that led to it; a refusal is logged, and a started turn that fails can be
   * retried from the page.
   */
  async chain(
    planId: string,
    action: Extract<PlanTurnAction, 'write' | 'decompose'>,
    taskId: string | null,
    authorId: string | null,
  ): Promise<void> {
    try {
      const plan = await this.prisma.plan.findUniqueOrThrow({
        where: { id: planId },
      });
      const task = taskId
        ? await this.prisma.planTask.findUniqueOrThrow({
            where: { id: taskId },
          })
        : null;
      await this.run(
        plan,
        { action, task, input: {} },
        {
          userId: authorId,
          role: 'operator',
          ctx: { actor: authorId ? systemActorFor(authorId) : SYSTEM_ACTOR },
        },
      );
    } catch (error) {
      this.logger.warn(
        `plan ${planId}: chained ${action} not started: ${(error as Error).message}`,
      );
    }
  }

  private async run(
    plan: Plan,
    spec: TurnSpec,
    caller: PlanCaller,
  ): Promise<string> {
    const project = await this.store.project(plan.projectId);
    const profile = await this.store.profile(project, plan.profileKey);
    this.commands.assertReady(project.runnerId, 'plan.turn');
    // Spec 28 D7, D11 and D14: a budget that refuses runs refuses a turn.
    await this.budgets?.assertAllowed({
      projectId: plan.projectId,
      userId: caller.userId,
    });

    const contractVersion = asPlannerContractVersion(plan.contractVersion);
    const intake = spec.action === 'intake';
    const discuss = spec.action === 'discuss';
    const [instructions, tasks, session, designParts, files] =
      await Promise.all([
        this.prisma.plannerInstructions.findUniqueOrThrow({
          where: { id: plan.instructionsId },
          select: { body: true, projectId: true },
        }),
        this.store.currentTasks(this.prisma, plan),
        this.session(plan, spec.task),
        designPromptParts(this.prisma, plan, project, spec, contractVersion),
        // #337 D10: an older runner gets the turn without the files.
        intake && runnerTakesPlanAttachments(project.runnerVersion)
          ? this.attachments.planRefs(plan.id, spec.claim)
          : Promise.resolve(null),
      ]);
    // #590: the skills the discussion chose, those still installed.
    const discussSkills = discuss
      ? await installedOf(this.prisma, project, plan.skills)
      : null;
    const intakeState = intake
      ? await intakeTurnState(this.prisma, plan.id, {
          id: '',
          input: spec.input as Prisma.JsonValue,
          createdAt: new Date(),
        })
      : null;
    const prompt = assemblePrompt({
      ...designParts,
      contractVersion,
      // #337 D9: an intake runs on the card-mode instructions; a project's
      // own instructions (an override, not the global default) apply too.
      instructions: intake ? readCardInstructions() : instructions.body,
      ...(intake
        ? {
            projectInstructions:
              instructions.projectId !== null ? instructions.body : null,
            intake: intakeState
              ? {
                  roundsAsked: intakeState.roundsAsked,
                  maxRounds: PLANNER_INTAKE_MAX_ROUNDS,
                  generate: intakeState.generate,
                  mustGenerate: intakeMustGenerate(intakeState),
                  keepOne: intakeState.keepOne === true,
                }
              : undefined,
            attachments: (files ?? []).map((f) =>
              attachmentWorktreePath(f.id, f.name),
            ),
          }
        : {}),
      // #590: a discussion runs on its own instructions (in the prompt); a
      // project's own instructions apply, as to an intake.
      ...(discussSkills
        ? {
            projectInstructions:
              instructions.projectId !== null ? instructions.body : null,
            discussion: {
              skills: plan.skills.filter((s) => discussSkills.has(s)),
            },
          }
        : {}),
      action: spec.action,
      brief: plan.brief,
      plan: { title: plan.title, mode: plan.mode, version: plan.version },
      tasks: tasks.map((t) => ({
        key: t.key,
        kind: t.kind,
        title: t.title,
        summary: t.summary,
        dependsOn: t.dependsOn,
        status: t.status,
        frozen: t.frozen,
        questions: questionsOf(t.questions),
        document: t.document,
        rewriteComment: t.rewriteComment,
      })),
      taskKey: spec.task?.key,
      round:
        spec.action === 'clarify'
          ? await this.store.planRound(plan.id)
          : intake
            ? await intakeRound(this.prisma, plan.id)
            : spec.task
              ? questionsOf(spec.task.questions)
              : [],
      input: spec.input,
    });
    // #445 D11: only a runner that advertises the token saver gets the field.
    const saver = await this.tokenSaver.launch(plan.projectId);
    const draft = {
      planId: plan.id,
      projectId: plan.projectId,
      root: project.rootPath,
      base: project.base,
      session,
      prompt,
      ...(files && files.length > 0 ? { attachments: files } : {}),
      profileKey: profile.key,
      model: plan.model,
      timeoutSec: PLAN_TURN_DEFAULT_TIMEOUT_SEC,
      ...saver.args,
    };
    // The ids are not known yet; any valid id checks the rest.
    const valid = planTurnArgsSchema.safeParse({
      ...draft,
      turnId: 'pending',
      runId: 'pending',
    });
    if (!valid.success) {
      throw plannerError(
        400,
        PLANNER_ERROR.invalidArgs,
        z.prettifyError(valid.error),
      );
    }

    const { turnId, runId } = await this.prisma.$transaction(async (tx) => {
      // Serializes turn starts of one plan: one turn at a time.
      await tx.$queryRaw`SELECT id FROM plans WHERE id = ${plan.id} FOR UPDATE`;
      const active = await tx.planTurn.findFirst({
        where: { planId: plan.id, phase: { in: [...ACTIVE] } },
        select: { id: true },
      });
      if (active) throw turnInProgress();
      // #337 D10: the turn's new files join the plan with it.
      if (spec.claim && spec.claim.length > 0) {
        await this.attachments.claimForPlan(
          tx,
          { projectId: plan.projectId, planId: plan.id },
          spec.claim,
          caller,
        );
      }
      if (spec.task && spec.task.sessionId === null) {
        await tx.planTask.update({
          where: { id: spec.task.id },
          data: { sessionId: session.id },
        });
      }
      if (spec.action === 'decompose' && plan.status === 'clarifying') {
        await tx.plan.update({
          where: { id: plan.id },
          data: { status: 'drafting' },
        });
      }
      const now = new Date();
      const run = await tx.run.create({
        data: {
          kind: 'plan',
          projectId: plan.projectId,
          title: spec.task
            ? `Plan ${spec.action}: ${spec.task.key}${spec.design ? ` v${spec.design.variant}` : ''}`
            : `Plan ${spec.action}`,
          runtime: profile.runtime,
          model: plan.model,
          profileKey: profile.key,
          args: {
            planId: plan.id,
            action: spec.action,
            ...(spec.task ? { taskKey: spec.task.key } : {}),
            ...(spec.design ? { design: spec.design } : {}),
          },
          tokenSaver: saver.on,
          status: 'running',
          triggeredByType: 'user',
          triggeredById: caller.userId,
          startedAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });
      const turn = await tx.planTurn.create({
        data: {
          planId: plan.id,
          taskId: spec.task?.id ?? null,
          runId: run.id,
          action: spec.action,
          authorId: caller.userId,
          input: spec.input as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { turnId: turn.id, runId: run.id };
    });
    this.store.publish(plan.projectId, plan.id);
    // #271 D3: this turn reads the person's words as typed.
    if (spec.normalize) {
      await this.text.request(
        plan.projectId,
        { ownerType: 'plan_turn', ownerId: turnId },
        [
          ...(spec.input.message
            ? [{ field: 'message', text: spec.input.message }]
            : []),
          ...(spec.input.answers ?? []).flatMap((answer) =>
            answer.text
              ? [
                  {
                    field: textAnswerField(answer.questionId),
                    text: answer.text,
                  },
                ]
              : [],
          ),
        ],
        { authorId: caller.userId },
      );
    }

    const args: PlanTurnArgs = { ...valid.data, turnId, runId };
    try {
      const output = plannerOutput(
        'plan.turn',
        await this.commands.send(project.runnerId, 'plan.turn', args, {
          role: caller.role,
          ctx: caller.ctx,
          // The prompt is data the audit log need not repeat in full.
          auditArgs: { ...args, prompt: `<${prompt.length} chars>` },
        }),
      );
      // Events may already have moved it on; never step back.
      await this.prisma.planTurn.updateMany({
        where: { id: turnId, phase: 'queued' },
        data: { phase: output.phase },
      });
      this.store.publish(plan.projectId, plan.id);
      return turnId;
    } catch (error) {
      if (!(error instanceof PlannerFailure)) throw error;
      // No answer: the runner may have started it; its events settle the turn.
      if (error.code !== PLANNER_ERROR.runnerTimeout) {
        await this.store.settleTurn(turnId, {
          phase: 'failed',
          error: error.message,
        });
        this.store.publish(plan.projectId, plan.id);
      }
      throw error;
    }
  }

  /**
   * D3. Plan-level: `--session-id` until the session exists, then `--resume`.
   * A task's first turn forks the plan session with an id the API chooses;
   * later ones resume the fork.
   */
  private async session(
    plan: Plan,
    task: PlanTask | null,
  ): Promise<PlanTurnSession> {
    if (!task) {
      const started = await this.prisma.planTurn.count({
        where: { planId: plan.id, taskId: null, ...sessionStarted },
      });
      return { id: plan.sessionId, resume: started > 0 };
    }
    const id = task.sessionId ?? randomUUID();
    const forked =
      task.sessionId !== null &&
      (await this.prisma.planTurn.count({
        where: { planId: plan.id, task: { key: task.key }, ...sessionStarted },
      })) > 0;
    return forked
      ? { id, resume: true }
      : { id, resume: true, forkFrom: plan.sessionId };
  }
}
