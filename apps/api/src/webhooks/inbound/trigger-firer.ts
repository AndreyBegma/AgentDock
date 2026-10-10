import {
  INBOUND_DELIVERY_REASONS,
  type InboundDeliveryReason,
  SKILLS_ERROR,
} from '@agentdock/shared';
import { ORCHESTRATOR_DEFAULTS } from '@agentdock/shared/protocol';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { InboundDelivery, InboundDeliveryStatus } from '@prisma/client';
import { SYSTEM_ACTOR } from '../../audit/audit.types';
import { ControlService } from '../../control/control.service';
import { PrismaService } from '../../database/prisma.service';
import { SkillRunService } from '../../skills';
import { InboundLive } from './inbound-live';
import { parseAction } from './trigger-action';

/** #28 D7: a gated start refused by a `stop` budget — 409 `budget_exceeded`. */
export const BUDGET_EXCEEDED = 'budget_exceeded';

/** How a firing ended, before it is written. */
interface Outcome {
  status: Exclude<InboundDeliveryStatus, 'accepted' | 'rejected'>;
  reason?: InboundDeliveryReason;
  runId?: string;
  commandRunId?: string;
}

/** The body of an API error the fired service threw, read structurally. */
const errorBody = (
  error: unknown,
): { code: string; runId?: string; commandRunId?: string } | null => {
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse();
  if (typeof body !== 'object' || body === null) return { code: 'error' };
  const record = body as Record<string, unknown>;
  const text = (key: string) =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined;
  return {
    // #28 documents `code`; every other API error carries `error`.
    code: text('error') ?? text('code') ?? 'error',
    runId: text('runId'),
    commandRunId: text('commandRunId'),
  };
};

/**
 * Fires an `accepted` inbound delivery after its 202 (D7): the trigger's
 * action through the same service a person's click goes through —
 * `SkillRunService.start` (#24) or `ControlService.start` (#17), with their
 * gates, #28's budgets among them. The rendered args travel as the
 * `skill.run` command's `args` value, never as shell text (ADR-0010).
 */
@Injectable()
export class TriggerFirer {
  private readonly logger = new Logger(TriggerFirer.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly skillRuns: SkillRunService,
    private readonly control: ControlService,
    private readonly live: InboundLive,
  ) {}

  /** Starts the firing once the current response is on its way. */
  schedule(job: { deliveryRowId: bigint }): void {
    const firing = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.fire(job.deliveryRowId))
      .then(
        () => undefined,
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `delivery ${job.deliveryRowId}: firing crashed: ${reason}`,
          );
        },
      )
      .finally(() => this.inFlight.delete(firing));
    this.inFlight.add(firing);
  }

  /** Resolves when every scheduled firing has settled. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** Fires `deliveryRowId` if it is still `accepted`; returns the row as it ends. */
  async fire(deliveryRowId: bigint): Promise<InboundDelivery> {
    const delivery = await this.prisma.inboundDelivery.findUniqueOrThrow({
      where: { id: deliveryRowId },
      include: {
        trigger: {
          include: { createdBy: { select: { id: true, email: true } } },
        },
      },
    });
    const { trigger, ...row } = delivery;
    if (row.status !== 'accepted') return row;

    let outcome: Outcome;
    try {
      outcome = await this.send(row, trigger);
    } catch (error) {
      outcome = this.failure(error);
    }
    return this.settle(row, outcome);
  }

  private async send(
    delivery: InboundDelivery,
    trigger: {
      id: string;
      projectId: string;
      action: unknown;
      createdBy: { id: string; email: string } | null;
    },
  ): Promise<Outcome> {
    // D5 was checked on receipt; a creator deleted since has no one to act for.
    if (!trigger.createdBy) {
      return {
        status: 'failed',
        reason: INBOUND_DELIVERY_REASONS.creatorNotAuthorized,
      };
    }
    // Spec 26 notes: fired as the system, on behalf of an active admin; the
    // run's trigger (`webhook`, the trigger's id) leads back to the person.
    const ctx = { actor: SYSTEM_ACTOR };
    const action = parseAction(trigger.action);
    if (action.kind === 'skill') {
      if (typeof delivery.renderedArgs !== 'string') {
        throw new Error('an accepted skill delivery has no rendered args');
      }
      const run = await this.skillRuns.start(
        trigger.projectId,
        {
          skill: action.skill,
          args: delivery.renderedArgs,
          ...(action.profileKey ? { profileKey: action.profileKey } : {}),
          model: action.model ?? ORCHESTRATOR_DEFAULTS.model,
          output: action.output,
        },
        { type: 'webhook', id: trigger.id, role: 'admin', ctx },
      );
      return { status: 'started', runId: run.runId };
    }
    const commandRun = await this.control.start(
      {
        projectId: trigger.projectId,
        role: 'admin',
        user: trigger.createdBy,
        ctx,
      },
      { mode: action.mode },
    );
    return { status: 'started', commandRunId: commandRun.id };
  }

  private failure(error: unknown): Outcome {
    const body = errorBody(error);
    if (!body) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`firing failed: ${reason}`);
      return {
        status: 'failed',
        reason: INBOUND_DELIVERY_REASONS.commandFailed,
      };
    }
    const ids = {
      ...(body.runId ? { runId: body.runId } : {}),
      ...(body.commandRunId ? { commandRunId: body.commandRunId } : {}),
    };
    switch (body.code) {
      // D6: #28's gate is the pre-fire hook (spec 26 notes).
      case BUDGET_EXCEEDED:
        return {
          status: 'skipped',
          reason: INBOUND_DELIVERY_REASONS.beforeFireDenied,
          ...ids,
        };
      // D6: the orchestrator is already up — one live run.
      case 'already_running':
        return {
          status: 'skipped',
          reason: INBOUND_DELIVERY_REASONS.previousStillRunning,
          ...ids,
        };
      case 'runner_offline':
      case SKILLS_ERROR.commandUnavailable:
        return {
          status: 'failed',
          reason: INBOUND_DELIVERY_REASONS.runnerOffline,
          ...ids,
        };
      // No answer in time: the runner may have started it; its events settle the run.
      case SKILLS_ERROR.runnerTimeout:
        if (body.runId) return { status: 'started', ...ids };
        break;
    }
    this.logger.warn(`firing failed: ${body.code}`);
    return {
      status: 'failed',
      reason: INBOUND_DELIVERY_REASONS.commandFailed,
      ...ids,
    };
  }

  /** Written once, only from `accepted`. */
  private async settle(
    delivery: InboundDelivery,
    outcome: Outcome,
  ): Promise<InboundDelivery> {
    const { count } = await this.prisma.inboundDelivery.updateMany({
      where: { id: delivery.id, status: 'accepted' },
      data: {
        status: outcome.status,
        reason: outcome.reason ?? null,
        ...(outcome.runId ? { runId: outcome.runId } : {}),
        ...(outcome.commandRunId ? { commandRunId: outcome.commandRunId } : {}),
      },
    });
    const row = await this.prisma.inboundDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    if (count > 0) this.live.delivery(row);
    return row;
  }
}
