import { createHash } from 'node:crypto';
import {
  type AuditAction,
  type CommandRunView,
  type ControlRunCommand,
  type OrchestratorStatusView,
  type Role,
  SLOT_MESSAGE_SENT_LIVE_EVENT,
  type SlotMessageSentEvent,
} from '@nautelle/shared';
import {
  type CommandArgs,
  type CommandResult,
  commands,
  slotNameSchema,
} from '@nautelle/shared/protocol';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { projectNotFound } from '../projects';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { TokenSaverService } from '../token-saver/token-saver.service';
import { CommandRunsService } from './command-runs.service';
import { ControlFailure, controlError } from './control-error';
import { CONTROL_OPTIONS, type ControlOptions } from './control-options';
import { controlOutcome } from './control-outcome';
import type { OrchestratorStartDto } from './dto';
import {
  BYPASS_NEEDS_ADMIN,
  OrchestratorSettingsService,
} from './orchestrator-settings.service';

/** Who calls, as the route resolved them. */
export interface ControlCaller {
  projectId: string;
  /** The caller's effective role on the project. */
  role: Role;
  user: { id: string; email: string };
  ctx: AuditContext;
}

interface CachedStatus {
  view: OrchestratorStatusView;
  expiresAt: number;
}

interface ProjectTarget {
  runnerId: string;
  rootPath: string;
}

/** One control action, as `execute` runs it. */
interface Action<N extends ControlRunCommand> {
  command: N;
  slot?: string;
  /** The audit action of spec 17 D10. */
  auditAction: AuditAction;
  /**
   * The command's args, or a refusal decided before anything is sent. Its
   * `args` are recorded on the run either way.
   */
  prepare: (
    project: ProjectTarget,
  ) => Promise<
    | { args: CommandArgs<N> }
    | { refused: ControlFailure; args: object; denied?: boolean }
  >;
  /** What the audit log and `runner.command` show instead of the args. */
  redact?: (args: CommandArgs<N>) => object;
  /** Called with the result before the run is returned. */
  after?: (run: CommandRunView, output: CommandResult<N>) => void;
}

const sha256 = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** D10: a message's text reaches the audit log as its hash and size only. */
export const redactMessage = (args: CommandArgs<'slot.message'>) => ({
  ...args,
  text: sha256(args.text),
  textBytes: Buffer.byteLength(args.text),
});

/** #189: the orchestrator's message reaches the audit log the same way. */
export const redactOrchestratorMessage = (
  args: CommandArgs<'orchestrator.message'>,
) => ({
  ...args,
  body: sha256(args.body),
  bodyBytes: Buffer.byteLength(args.body),
});

/**
 * Orchestrator and slot control (spec 17): each action is a typed runner
 * command, recorded as a `command_runs` row, audited, and published live.
 * The POST waits for the runner (at most the D11 timeout) and answers with
 * the finished run, or with the mapped error and the run's id.
 */
@Injectable()
export class ControlService {
  private readonly logger = new Logger(ControlService.name);
  private readonly statuses = new Map<string, CachedStatus>();
  private readonly pendingStatuses = new Map<
    string,
    Promise<OrchestratorStatusView>
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly live: LiveService,
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
    private readonly runs: CommandRunsService,
    private readonly settings: OrchestratorSettingsService,
    private readonly tokenSaver: TokenSaverService,
    @Inject(CONTROL_OPTIONS) private readonly options: ControlOptions,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /** D2, D3: launches `/code-sentinel:orchestrator <mode>` in its own tmux session. */
  start(
    caller: ControlCaller,
    dto: OrchestratorStartDto,
  ): Promise<CommandRunView> {
    return this.execute(caller, {
      command: 'orchestrator.start',
      auditAction: 'orchestrator.start',
      prepare: async () => {
        // Spec 28 D7, D11: an exceeded stop budget refuses start and next
        // with 409 `budget_exceeded`, before a run is recorded or sent. A
        // schedule firing (actor `system`) had its principal's user budget
        // checked by the pre-fire hook (D-10).
        await this.budgets?.assertAllowed({
          projectId: caller.projectId,
          userId: caller.ctx.actor.type === 'user' ? caller.user.id : null,
        });
        const launch = await this.settings
          .resolveLaunch(caller.projectId, dto)
          .catch((error: unknown) => {
            if (error instanceof ControlFailure) return error;
            throw error;
          });
        const requested = { projectId: caller.projectId, ...dto };
        if (launch instanceof ControlFailure) {
          return { refused: launch, args: requested };
        }
        // Only an override needs admin; a project setting was set by one (D3).
        if (
          dto.permissionMode === 'bypassPermissions' &&
          caller.role !== 'admin'
        ) {
          return {
            refused: new ControlFailure(403, 'forbidden', BYPASS_NEEDS_ADMIN),
            args: requested,
            denied: true,
          };
        }
        if (!launch.profile) {
          return {
            refused: new ControlFailure(
              422,
              'no_profile',
              'No runtime profile is set for this project’s orchestrator',
            ),
            args: requested,
          };
        }
        // #445 D11: only a runner that advertises the token saver gets the
        // field. The orchestrator session has no run row to mark.
        const saver = await this.tokenSaver.launch(caller.projectId);
        return {
          args: {
            projectId: caller.projectId,
            root: launch.rootPath,
            profileId: launch.profile.key,
            model: launch.model,
            permissionMode: launch.permissionMode,
            mode: dto.mode,
            ...saver.args,
          },
        };
      },
    });
  }

  /** D4: kills the orchestrator's session only; workers keep running. */
  stop(caller: ControlCaller): Promise<CommandRunView> {
    return this.execute(caller, {
      command: 'orchestrator.stop',
      auditAction: 'orchestrator.stop',
      prepare: async (project) => ({
        args: { projectId: caller.projectId, root: project.rootPath },
      }),
    });
  }

  /**
   * #189: the runner writes the message beside the orchestrator's board and
   * pokes its session, which it resolves itself. Not delivered when the
   * orchestrator is absent or its pane shows a dialog — an `ok` run either way.
   */
  messageOrchestrator(
    caller: ControlCaller,
    body: string,
  ): Promise<CommandRunView> {
    return this.execute(caller, {
      command: 'orchestrator.message',
      auditAction: 'orchestrator.message',
      prepare: async (project) => ({
        args: {
          projectId: caller.projectId,
          root: project.rootPath,
          body,
          from: caller.user.email,
        },
      }),
      redact: redactOrchestratorMessage,
    });
  }

  /** D6: kills the slot's session; its worktree, branch and commits stay. */
  stopSlot(caller: ControlCaller, slot: string): Promise<CommandRunView> {
    return this.execute(caller, {
      command: 'slot.stop',
      slot,
      auditAction: 'slot.stop',
      prepare: async (project) => ({
        args: { projectId: caller.projectId, root: project.rootPath, slot },
      }),
    });
  }

  /** D7, D8: writes the worker's message file and pokes its session. */
  messageSlot(
    caller: ControlCaller,
    slot: string,
    text: string,
  ): Promise<CommandRunView> {
    return this.execute(caller, {
      command: 'slot.message',
      slot,
      auditAction: 'slot.message',
      prepare: async (project) => ({
        args: {
          projectId: caller.projectId,
          root: project.rootPath,
          slot,
          text,
          from: caller.user.email,
        },
      }),
      redact: redactMessage,
      after: (run, output) => {
        const event: SlotMessageSentEvent = {
          projectId: caller.projectId,
          slot,
          commandRunId: run.id,
          userId: caller.user.id,
          delivered: output.delivered,
          at: run.finishedAt ?? new Date().toISOString(),
        };
        this.publish(caller.projectId, SLOT_MESSAGE_SENT_LIVE_EVENT, event);
      },
    });
  }

  /**
   * D5: presence and pane state, read from the runner; no run row (a read).
   * One answer serves a project for `statusCacheMs`, and callers that ask
   * while it is being fetched share that one command (C-119).
   */
  async status(caller: ControlCaller): Promise<OrchestratorStatusView> {
    const project = await this.project(caller.projectId);
    if (!this.presence.isConnected(project.runnerId)) {
      throw controlError(409, 'runner_offline', 'The runner is not connected');
    }
    const cached = this.statuses.get(caller.projectId);
    if (cached && cached.expiresAt > Date.now()) return cached.view;
    const running = this.pendingStatuses.get(caller.projectId);
    if (running) return running;
    const current = () =>
      this.pendingStatuses.get(caller.projectId) === request;
    const request = this.fetchStatus(caller, project)
      .then((view) => {
        // A command sent meanwhile forgot this read: it may predate it.
        if (current()) {
          this.statuses.set(caller.projectId, {
            view,
            expiresAt: Date.now() + this.options.statusCacheMs,
          });
        }
        return view;
      })
      .finally(() => {
        if (current()) this.pendingStatuses.delete(caller.projectId);
      });
    this.pendingStatuses.set(caller.projectId, request);
    return request;
  }

  private async fetchStatus(
    caller: ControlCaller,
    project: ProjectTarget,
  ): Promise<OrchestratorStatusView> {
    const outcome = controlOutcome(
      'orchestrator.status',
      await this.commands.send(
        project.runnerId,
        'orchestrator.status',
        { projectId: caller.projectId, root: project.rootPath },
        {
          role: caller.role,
          ctx: caller.ctx,
          timeoutMs: this.options.timeoutsMs['orchestrator.status'],
        },
      ),
    );
    if (outcome.status !== 'ok') throw outcome.failure.toHttp();
    const { present, state, session, startedAt } = outcome.output;
    return {
      present,
      state,
      session: session ?? null,
      startedAt: startedAt ?? null,
    };
  }

  /** A command changed what `status` reads: the next read asks the runner. */
  private forgetStatus(projectId: string): void {
    this.statuses.delete(projectId);
    this.pendingStatuses.delete(projectId);
  }

  /** A `:slot` route param, checked before anything is recorded or sent. */
  parseSlot(slot: string): string {
    const parsed = slotNameSchema.safeParse(slot);
    if (!parsed.success) {
      throw controlError(
        400,
        'invalid_args',
        `slot ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private async execute<N extends ControlRunCommand>(
    caller: ControlCaller,
    action: Action<N>,
  ): Promise<CommandRunView> {
    const project = await this.project(caller.projectId);
    this.forgetStatus(caller.projectId);
    let prepared = await action.prepare(project);
    // The command's args once they are complete — redacted for the audit log
    // even when the action is refused afterwards (offline).
    const commandArgs = 'refused' in prepared ? null : prepared.args;

    if (commandArgs) {
      // What the DTOs cannot see — the message's byte size, a blank text —
      // is input validation: answered 400 before a run exists.
      const valid = commands[action.command].args.safeParse(commandArgs);
      if (!valid.success) {
        throw controlError(400, 'invalid_args', z.prettifyError(valid.error));
      }
      if (!this.presence.isConnected(project.runnerId)) {
        prepared = {
          refused: new ControlFailure(
            409,
            'runner_offline',
            'The runner is not connected',
          ),
          args: commandArgs,
        };
      }
    }

    const sent = 'refused' in prepared ? null : prepared.args;
    const auditArgs =
      commandArgs && action.redact ? action.redact(commandArgs) : prepared.args;
    const run = await this.runs.create({
      projectId: caller.projectId,
      runnerId: project.runnerId,
      userId: caller.user.id,
      command: action.command,
      slot: action.slot,
      args: prepared.args,
    });
    const record = (result: 'ok' | 'error' | 'denied', outcome: object) =>
      this.audit.record({
        ...caller.ctx,
        action: action.auditAction,
        target: action.slot
          ? { type: 'slot', id: action.slot }
          : { type: 'project', id: caller.projectId },
        projectId: caller.projectId,
        after: { args: auditArgs, ...outcome },
        result,
        meta: { commandRunId: run.id },
      });

    if ('refused' in prepared) {
      const { refused } = prepared;
      await this.runs.finish(run.id, {
        status: 'error',
        error: { code: refused.code, message: refused.message },
      });
      await record(prepared.denied ? 'denied' : 'error', {
        error: refused.code,
      });
      throw refused.toHttp(run.id);
    }

    let outcome: ReturnType<typeof controlOutcome<CommandResult<N>>>;
    try {
      outcome = controlOutcome(
        action.command,
        await this.commands.send(project.runnerId, action.command, sent, {
          role: caller.role,
          ctx: caller.ctx,
          timeoutMs: this.options.timeoutsMs[action.command],
          ...(action.redact && sent ? { auditArgs } : {}),
        }),
      );
    } catch (error) {
      // Never leave a run `requested` behind an exception.
      await this.runs.finish(run.id, {
        status: 'error',
        error: { code: 'runner_error', message: 'The command was not sent' },
      });
      await record('error', { error: 'runner_error' });
      throw error;
    }

    if (outcome.status !== 'ok') {
      const { failure } = outcome;
      await this.runs.finish(run.id, {
        status: outcome.status,
        error: { code: failure.code, message: failure.message },
      });
      await record('error', { status: outcome.status, error: failure.code });
      throw failure.toHttp(run.id);
    }

    // A status read sent while the command ran may predate it.
    this.forgetStatus(caller.projectId);
    const finished = await this.runs.finish(run.id, {
      status: 'ok',
      result: outcome.output as object,
    });
    await record('ok', { result: outcome.output });
    action.after?.(finished, outcome.output);
    return finished;
  }

  private async project(projectId: string): Promise<ProjectTarget> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { runnerId: true, rootPath: true },
    });
    if (!project) throw projectNotFound();
    return project;
  }

  private publish(projectId: string, type: string, data: unknown): void {
    try {
      this.live.publish(`project:${projectId}`, type, data);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${type} not published: ${reason}`);
    }
  }
}
