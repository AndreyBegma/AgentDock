import {
  type CardRoundPhase,
  isActiveRoundPhase,
  STEWARD_NUDGE_TEXT,
  type StewardActableSubject,
  type StewardAction,
  type StewardActionRecord,
  type StewardActionResult,
  type StewardDialogId,
  stewardActionCount,
} from '@agentdock/shared';
import {
  type CardResumeArgs,
  cardResumeArgsSchema,
  ORCHESTRATOR_DEFAULTS,
  orchestratorPermissionModeSchema,
  type Role,
  roleAtLeast,
  type StewardCommandName,
} from '@agentdock/shared/protocol';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { Prisma, StewardIncident } from '@prisma/client';
import type { AuditContext } from '../audit/audit.types';
import { SYSTEM_ACTOR, systemActorFor } from '../audit/audit.types';
import { BoardRoundsService } from '../board/board-rounds.service';
import { BoardWork } from '../board/board-work';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import type { CommandSendResult } from '../runners/runner-command.service';
import { TokenSaverService } from '../token-saver/token-saver.service';
import {
  type StewardCommandArgs,
  type StewardCommandOutput,
  StewardCommands,
} from './steward-commands';
import {
  actionsOf,
  type ResolvedSubject,
  StewardIncidents,
  type StewardProject,
  stewardProjectSelect,
} from './steward-incidents.service';
import { nextStep, PENDING_DETAIL } from './steward-policy';
import { StewardSettingsService } from './steward-settings.service';

/** How often the sweep looks at open incidents: due second nudges, lost decisions. */
export const STEWARD_SWEEP_MS = 30_000;

/**
 * A dialog incident younger than this is left to the decision its
 * observation started — only that one knows the dialog's id (D11).
 */
const DIALOG_GRACE_MS = 60_000;

/** The `detail` of an attempt the runner never answered. */
export const NO_ANSWER_DETAIL = 'no answer from the runner';

/** Who an automatic action acts as (DA-15, D-09/D-10): the round's starter. */
interface Principal {
  userId: string | null;
  role: Role;
  ctx: AuditContext;
}

/** A card round as a decision reads it. */
interface RoundFacts {
  id: string;
  runId: string;
  phase: CardRoundPhase;
  finishedBy: string | null;
  trigger: string;
  authorId: string | null;
  latest: boolean;
  card: {
    id: string;
    projectId: string;
    column: string;
    shortId: string;
    branch: string | null;
    sessionId: string | null;
  };
  run: {
    model: string | null;
    profileKey: string | null;
    args: Prisma.JsonValue;
  };
}

/** Whether the subject is still the stall's: else the incident is moot. */
type Standing = 'stands' | 'moot';

/**
 * Steward's decisions (#447 D4, D9–D11, ADR-0040): the next step of each
 * open incident, from `nextStep`, under the project's switches, the runner's
 * capability, the per-round limits and the starter's budget — and the
 * command that carries it out. Every attempt is claimed on the incident
 * before it is sent, so a retry, the sweep and a second API instance send it
 * once. A doubt escalates; nothing is ever sent for a fleet slot (D5).
 */
@Injectable()
export class StewardDecider implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StewardDecider.name);
  private readonly inFlight = new Set<Promise<void>>();
  /** D11: the dialog an observation named, until its decision ran. */
  private readonly dialogs = new Map<string, StewardDialogId>();
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly incidents: StewardIncidents,
    private readonly settings: StewardSettingsService,
    private readonly commands: StewardCommands,
    private readonly rounds: BoardRoundsService,
    private readonly work: BoardWork,
    private readonly access: ProjectAccessService,
    private readonly tokenSaver: TokenSaverService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  onApplicationBootstrap(): void {
    // Tests drive `tick()` themselves.
    if (process.env.APP_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error(`steward sweep failed: ${errorText(error)}`);
      });
    }, STEWARD_SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * Decides `incidentId` after the current batch — a sink never waits on a
   * runner command. `dialogId` is the dialog the observation named.
   */
  later(incidentId: string, dialogId?: StewardDialogId): void {
    if (dialogId) this.dialogs.set(incidentId, dialogId);
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.decide(incidentId))
      .catch((error: unknown) => {
        this.logger.error(
          `steward decision on ${incidentId} failed: ${errorText(error)}`,
        );
      });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /** Resolves once every decision started so far has settled. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /**
   * One look at every live incident — a second nudge that came due, a
   * decision lost to a restart, a stall whose round has ended. A sweep
   * under way is skipped.
   */
  async tick(now = new Date()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const open = await this.prisma.stewardIncident.findMany({
        where: { status: { in: ['open', 'escalated'] } },
        orderBy: { openedAt: 'asc' },
        select: { id: true, kind: true, openedAt: true, actions: true },
        take: 500,
      });
      for (const incident of open) {
        if (
          incident.kind === 'dialog' &&
          !this.dialogs.has(incident.id) &&
          actionsOf(incident.actions).length === 0 &&
          now.getTime() - incident.openedAt.getTime() < DIALOG_GRACE_MS
        ) {
          continue;
        }
        await this.decide(incident.id, now);
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** The next step of one incident, carried out. */
  async decide(incidentId: string, now = new Date()): Promise<void> {
    const dialogId = this.dialogs.get(incidentId) ?? null;
    this.dialogs.delete(incidentId);
    const incident = await this.prisma.stewardIncident.findUnique({
      where: { id: incidentId },
    });
    if (!incident || incident.status === 'resolved') return;
    const project = await this.prisma.project.findUnique({
      where: { id: incident.projectId },
      select: stewardProjectSelect,
    });
    if (!project) return;
    const settings = await this.settings.of(project.id);
    // Steward off: nothing more happens (D16).
    if (!settings.enabled) return;

    const round =
      incident.subjectKind === 'card_round'
        ? await this.roundFacts(incident.subjectId)
        : null;
    const subject = await this.incidents.subjectFor(incident);
    if ((await this.standing(incident, round)) === 'moot') {
      await this.incidents.resolve(project, subject, incident.id, now);
      return;
    }
    // A person has it: Steward acts no more, and tells them again only of a
    // changed reason (D13).
    if (incident.status === 'escalated') {
      if (incident.reason !== incident.notifiedReason) {
        await this.incidents.escalate(project, subject, incident.id);
      }
      return;
    }

    const roundActions = (
      await this.prisma.stewardIncident.findMany({
        where: {
          subjectKind: incident.subjectKind,
          subjectId: incident.subjectId,
        },
        orderBy: { openedAt: 'asc' },
        select: { actions: true },
      })
    ).flatMap((i) => actionsOf(i.actions));

    const step = nextStep({
      subjectKind: incident.subjectKind,
      kind: incident.kind,
      actions: actionsOf(incident.actions),
      roundActions,
      settings,
      dialogId,
      now,
    });
    switch (step.step) {
      case 'none':
      case 'wait':
        return;
      case 'escalate':
        await this.incidents.escalate(project, subject, incident.id);
        return;
      case 'nudge':
      case 'dismiss':
      case 'resume':
        await this.act(
          project,
          subject,
          incident,
          round,
          step,
          roundActions,
          now,
        );
        return;
    }
  }

  /**
   * The runner's `steward.acted` for a commanded action whose answer never
   * came: it settles the attempt left without one.
   */
  async confirm(
    project: StewardProject,
    subject: ResolvedSubject,
    action: StewardAction,
    result: StewardActionResult,
  ): Promise<void> {
    const recent = await this.prisma.stewardIncident.findMany({
      where: { subjectKind: subject.kind, subjectId: subject.id },
      orderBy: { openedAt: 'desc' },
      take: 5,
    });
    for (const incident of recent) {
      const actions = actionsOf(incident.actions);
      const index = actions.findLastIndex(
        (a) =>
          a.action === action &&
          (a.detail === PENDING_DETAIL || a.detail === NO_ANSWER_DETAIL),
      );
      if (index < 0) continue;
      const attempt = stewardActionCount(actions.slice(0, index + 1), action);
      await this.incidents.settle(
        project,
        subject,
        incident.id,
        index,
        { result },
        attempt,
      );
      return;
    }
  }

  private async act(
    project: StewardProject,
    subject: ResolvedSubject,
    incident: StewardIncident,
    round: RoundFacts | null,
    step:
      | { step: 'nudge' }
      | { step: 'dismiss'; dialogId: StewardDialogId }
      | { step: 'resume' },
    roundActions: readonly StewardActionRecord[],
    now: Date,
  ): Promise<void> {
    const escalate = () =>
      this.incidents.escalate(project, subject, incident.id);
    const name: StewardCommandName =
      step.step === 'nudge'
        ? 'session.nudge'
        : step.step === 'dismiss'
          ? 'session.dismiss'
          : 'card.resume';
    if (!(await this.commands.available(project.runnerId, name))) {
      await escalate();
      return;
    }
    const target = this.actableOf(incident, round);
    const principal = await this.principal(project.id, incident, round);
    if (!target || !principal) {
      await escalate();
      return;
    }
    // D-09/D-10: an action that spends is the starter's spend.
    if (step.step !== 'dismiss' && this.budgets) {
      const budget = await this.budgets.check({
        projectId: project.id,
        userId: principal.userId,
      });
      if (!budget.allowed) {
        await escalate();
        return;
      }
    }
    const resumeArgs =
      step.step === 'resume' && round
        ? await this.resumeArgs(project, round, principal)
        : null;
    if (step.step === 'resume' && !resumeArgs) {
      await escalate();
      return;
    }

    const action: StewardAction = step.step;
    const claimed = await this.incidents.claim(subject, incident, {
      action,
      at: now.toISOString(),
      result: 'failed',
      detail: PENDING_DETAIL,
    });
    if (!claimed) return;
    const index = actionsOf(claimed.actions).length - 1;
    const attempt = stewardActionCount(roundActions, action) + 1;

    if (step.step === 'resume' && round) {
      const reopened = await this.rounds.reopenForResume(round.id);
      if (reopened === 'refused') {
        await this.incidents.settle(
          project,
          subject,
          incident.id,
          index,
          { result: 'failed', detail: 'the round cannot be resumed' },
          attempt,
        );
        await escalate();
        return;
      }
    }

    const options = { role: principal.role, ctx: principal.ctx };
    const { outcome, after } = await this.carryOut(
      project,
      target,
      step,
      resumeArgs,
      options,
    );
    await this.incidents.settle(
      project,
      subject,
      incident.id,
      index,
      outcome,
      attempt,
    );
    if (after === 'revert_escalate' && round) {
      await this.rounds.revertResume(round.id);
    }
    if (after !== 'decide') {
      await escalate();
      return;
    }
    // A failed attempt may leave nothing more to try (the limits): decide
    // again — a wait stays a wait, a spent limit escalates.
    if (outcome.result === 'failed' && outcome.detail !== NO_ANSWER_DETAIL) {
      await this.decide(incident.id, now);
    }
  }

  /**
   * Sends the step's command and reads its answer. `after`: decide again
   * (`decide`), or escalate — first putting a reopened round back when the
   * resume started nothing (`revert_escalate`).
   */
  private async carryOut(
    project: StewardProject,
    target: StewardActableSubject,
    step:
      | { step: 'nudge' }
      | { step: 'dismiss'; dialogId: StewardDialogId }
      | { step: 'resume' },
    resumeArgs: CardResumeArgs | null,
    options: { role: Role; ctx: AuditContext },
  ): Promise<{
    outcome: Outcome;
    after: 'decide' | 'escalate' | 'revert_escalate';
  }> {
    if (step.step === 'nudge') {
      const sent = await this.send(
        project.runnerId,
        'session.nudge',
        { projectId: project.id, subject: target, text: STEWARD_NUDGE_TEXT },
        options,
      );
      const outcome = outcomeOf(sent, (o) =>
        o.sent
          ? { result: 'ok' }
          : { result: 'failed', detail: 'the session was not at its prompt' },
      );
      return { outcome, after: 'decide' };
    }
    if (step.step === 'dismiss') {
      const sent = await this.send(
        project.runnerId,
        'session.dismiss',
        { projectId: project.id, subject: target, dialogId: step.dialogId },
        options,
      );
      const outcome = outcomeOf(sent, (o) =>
        o.dismissed
          ? { result: 'ok' }
          : { result: 'failed', detail: 'the dialog was no longer shown' },
      );
      return { outcome, after: 'decide' };
    }
    if (!resumeArgs) {
      return {
        outcome: { result: 'failed', detail: 'the round cannot be resumed' },
        after: 'revert_escalate',
      };
    }
    const sent = await this.send(
      project.runnerId,
      'card.resume',
      resumeArgs,
      options,
    );
    const outcome = outcomeOf(sent, (o): Outcome => {
      switch (o.outcome) {
        case 'resumed':
          return { result: 'ok' };
        case 'alive':
          return { result: 'failed', detail: 'the session is still alive' };
        case 'no_worktree':
          return { result: 'failed', detail: 'the round has no worktree' };
      }
    });
    if (sent.status === 'ok') {
      if (sent.output.outcome === 'resumed') {
        return { outcome, after: 'decide' };
      }
      return {
        outcome,
        after:
          sent.output.outcome === 'no_worktree'
            ? 'revert_escalate'
            : 'escalate',
      };
    }
    // A refusal started nothing: the round goes back as its session left it.
    // No answer: the runner may have started it; its events settle it.
    return {
      outcome,
      after: sent.status === 'error' ? 'revert_escalate' : 'decide',
    };
  }

  private send<N extends StewardCommandName>(
    runnerId: string,
    name: N,
    args: StewardCommandArgs<N>,
    options: { role: Role; ctx: AuditContext },
  ): Promise<CommandSendResult<N>> {
    return this.commands
      .send(runnerId, name, args, options)
      .catch((error: unknown): CommandSendResult<N> => {
        this.logger.warn(`${name} not sent: ${errorText(error)}`);
        return {
          status: 'error',
          error: { code: 'internal', message: errorText(error) },
        };
      });
  }

  private async roundFacts(roundId: string): Promise<RoundFacts | null> {
    const round = await this.prisma.boardCardRound.findUnique({
      where: { id: roundId },
      select: {
        id: true,
        runId: true,
        phase: true,
        finishedBy: true,
        trigger: true,
        authorId: true,
        round: true,
        run: { select: { model: true, profileKey: true, args: true } },
        card: {
          select: {
            id: true,
            projectId: true,
            column: true,
            shortId: true,
            branch: true,
            sessionId: true,
            rounds: {
              orderBy: { round: 'desc' },
              take: 1,
              select: { id: true },
            },
          },
        },
      },
    });
    if (!round) return null;
    const { rounds, ...card } = round.card;
    return {
      id: round.id,
      runId: round.runId,
      phase: round.phase,
      finishedBy: round.finishedBy,
      trigger: round.trigger,
      authorId: round.authorId,
      latest: rounds[0]?.id === round.id,
      card,
      run: round.run,
    };
  }

  /**
   * An incident stands while its stall can still be Steward's: a card
   * round that is the card's latest and active — or, for a dead session,
   * one its session alone ended; a run not ended. A fleet slot always
   * stands; its recovery is the sink's.
   */
  private async standing(
    incident: StewardIncident,
    round: RoundFacts | null,
  ): Promise<Standing> {
    switch (incident.subjectKind) {
      case 'card_round': {
        if (!round?.latest) return 'moot';
        if (isActiveRoundPhase(round.phase)) return 'stands';
        return incident.kind === 'dead_session' &&
          round.phase === 'finished' &&
          round.finishedBy === 'session_end'
          ? 'stands'
          : 'moot';
      }
      case 'run': {
        const run = await this.prisma.run.findUnique({
          where: { id: incident.subjectId },
          select: { endedAt: true },
        });
        return run && run.endedAt === null ? 'stands' : 'moot';
      }
      case 'fleet_slot':
        return 'stands';
    }
  }

  /** The command subject — never a fleet slot (D5). */
  private actableOf(
    incident: StewardIncident,
    round: RoundFacts | null,
  ): StewardActableSubject | null {
    if (incident.subjectKind === 'card_round' && round) {
      return { kind: 'card_round', cardId: round.card.id, runId: round.runId };
    }
    if (incident.subjectKind === 'run') {
      return { kind: 'run', runId: incident.subjectId };
    }
    return null;
  }

  /**
   * DA-15: the round's starter, with the role they hold on the project now
   * — a starter who was disabled, lost the project or the operator role acts
   * no more. A round the system started acts as the system.
   */
  private async principal(
    projectId: string,
    incident: StewardIncident,
    round: RoundFacts | null,
  ): Promise<Principal | null> {
    let starterId: string | null;
    if (round) {
      starterId = round.authorId;
    } else {
      const run = await this.prisma.run.findUnique({
        where: { id: incident.subjectId },
        select: { triggeredById: true },
      });
      starterId = run?.triggeredById ?? null;
    }
    if (starterId === null) {
      return { userId: null, role: 'operator', ctx: { actor: SYSTEM_ACTOR } };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: starterId },
      select: { id: true, role: true, status: true },
    });
    if (!user || user.status !== 'active') return null;
    const access = await this.access.resolve(user, projectId);
    if (!access || !roleAtLeast(access.role, 'operator')) return null;
    return {
      userId: user.id,
      role: access.role,
      ctx: { actor: systemActorFor(user.id) },
    };
  }

  /**
   * D10, DA-15: the round's own launch facts. The permission mode is the
   * one the round started in (`runs.args.permissionMode`), else the
   * project's; `bypassPermissions` needs the starter to be a project admin
   * now — as on a Run — except for AgentDock's own `ci_fix` round. `null`:
   * the round cannot be resumed as it started.
   */
  private async resumeArgs(
    project: StewardProject,
    round: RoundFacts,
    principal: Principal,
  ): Promise<CardResumeArgs | null> {
    const { card, run } = round;
    if (!card.sessionId || !card.branch || !run.profileKey || !run.model) {
      return null;
    }
    const permissionMode = await this.permissionModeOf(project.id, run.args);
    if (
      permissionMode === 'bypassPermissions' &&
      principal.role !== 'admin' &&
      round.trigger !== 'ci_fix'
    ) {
      return null;
    }
    const board = await this.work.project(project.id);
    const saver = await this.tokenSaver.launch(project.id);
    const args = cardResumeArgsSchema.safeParse({
      cardId: card.id,
      projectId: project.id,
      runId: round.runId,
      root: project.rootPath,
      base: board.base,
      shortId: card.shortId,
      branch: card.branch,
      sessionId: card.sessionId,
      profileKey: run.profileKey,
      model: run.model,
      permissionMode,
      ...saver.args,
    });
    if (!args.success) {
      this.logger.warn(
        `round ${round.id}: resume args invalid: ${args.error.message}`,
      );
      return null;
    }
    return args.data;
  }

  private async permissionModeOf(projectId: string, args: Prisma.JsonValue) {
    const stored =
      typeof args === 'object' && args !== null && !Array.isArray(args)
        ? orchestratorPermissionModeSchema.safeParse(args.permissionMode)
        : null;
    if (stored?.success) return stored.data;
    const settings = await this.prisma.projectOrchestratorSettings.findUnique({
      where: { projectId },
      select: { permissionMode: true },
    });
    return settings?.permissionMode ?? ORCHESTRATOR_DEFAULTS.permissionMode;
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** How an attempt ended, as its action record keeps it. */
type Outcome = Pick<StewardActionRecord, 'result' | 'detail'>;

/** A command's answer as an action's outcome. */
const outcomeOf = <N extends StewardCommandName>(
  sent: CommandSendResult<N>,
  ok: (output: StewardCommandOutput<N>) => Outcome,
): Outcome => {
  switch (sent.status) {
    case 'ok':
      return ok(sent.output);
    case 'error':
      return {
        result: 'failed',
        detail: `the runner refused: ${sent.error.code}`,
      };
    case 'unknown':
      return { result: 'failed', detail: NO_ANSWER_DETAIL };
  }
};
