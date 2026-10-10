import {
  INBOUND_DELIVERY_REASONS,
  type InboundHookAccepted,
  type InboundTemplateError,
  renderArgsTemplate,
  WEBHOOKS_ERROR,
} from '@agentdock/shared';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import {
  type InboundDelivery,
  type InboundDeliveryStatus,
  type InboundTrigger,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { SYSTEM_ACTOR } from '../../audit/audit.types';
import { PrismaService } from '../../database/prisma.service';
import {
  parseRawJson,
  verifyInboundSignature,
  WebhookSecrets,
  webhooksError,
} from '../common';
import { InboundLive } from './inbound-live';
import { take } from './token-bucket';
import { parseAction } from './trigger-action';

/** `inbound_deliveries.reason` of a body that is not JSON. */
export const INVALID_JSON_REASON = 'invalid_json';

/**
 * An `accepted` delivery whose firing has not settled yet counts as a live
 * run (D6) for this long — after a crash between the 202 and the firing it
 * stops blocking the trigger.
 */
export const ACCEPTED_LIVE_MS = 10 * 60 * 1000;

export interface HookRequest {
  publicId: string;
  rawBody: Buffer | undefined;
  timestamp: string | undefined;
  deliveryId: string | undefined;
  signature: string | undefined;
  sourceIp: string | null;
}

/** A recorded delivery: the 202 body, and the firing to start once it is sent. */
export interface HookReceived {
  answer: InboundHookAccepted;
  fire: { deliveryRowId: bigint } | null;
}

type Decision =
  | { kind: 'gone' }
  | { kind: 'replayed' }
  | { kind: 'limited' }
  | {
      kind: 'recorded';
      row: InboundDelivery;
      invalid?: { reason: InboundTemplateError | null; path?: string };
      creatorRevoked?: boolean;
    };

/**
 * `POST /hooks/:publicId` (spec 26 D1–D7). Verifies the signature over the
 * raw bytes, then — in one transaction holding the trigger's row — the
 * replay nonce, the rate limit, the D4 rendering, the creator's authority
 * and the one-live-run rule, and records the delivery. Nothing is sent to a
 * runner here: an `accepted` delivery is fired by `TriggerFirer` after the
 * 202 (D7).
 */
@Injectable()
export class InboundHookService {
  private readonly logger = new Logger(InboundHookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: WebhookSecrets,
    private readonly audit: AuditService,
    private readonly live: InboundLive,
  ) {}

  /** Null: no such enabled trigger — the caller answers 404 with no body (D1). */
  async receive(input: HookRequest): Promise<HookReceived | null> {
    const trigger = await this.prisma.inboundTrigger.findUnique({
      where: { publicId: input.publicId },
    });
    if (!trigger?.enabled) return null;

    const now = new Date();
    const verdict = verifyInboundSignature({
      timestamp: input.timestamp,
      deliveryId: input.deliveryId,
      signature: input.signature,
      rawBody: input.rawBody ?? Buffer.alloc(0),
      secrets: this.openSecrets(trigger, now),
      now,
    });
    // D2: 401 with no detail; the reason stays in the log.
    if (!verdict.ok || !input.deliveryId) {
      const reason = verdict.ok ? 'missing_header' : verdict.reason;
      this.logger.warn(`trigger ${trigger.id}: signature refused (${reason})`);
      throw new UnauthorizedException();
    }
    const deliveryId = input.deliveryId;

    const decision = await this.decide(trigger, deliveryId, input, now).catch(
      (error: unknown) => {
        // The lock makes this unreachable for one trigger; kept as the nonce's last word.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          return { kind: 'replayed' } as const;
        throw error;
      },
    );
    switch (decision.kind) {
      case 'gone':
        return null;
      case 'replayed':
        throw webhooksError(
          409,
          WEBHOOKS_ERROR.replayed,
          'This delivery id was already received',
        );
      case 'limited':
        throw webhooksError(
          429,
          WEBHOOKS_ERROR.rateLimited,
          'Too many deliveries for this trigger; try again later',
        );
    }

    const { row } = decision;
    this.live.delivery(row);
    if (decision.creatorRevoked) await this.disableForCreator(trigger, row);
    if (decision.invalid) {
      const { reason, path } = decision.invalid;
      throw webhooksError(
        422,
        WEBHOOKS_ERROR.invalidPayload,
        'The payload does not render this trigger’s arguments',
        {
          ...(reason ? { reason } : {}),
          ...(path !== undefined ? { path } : {}),
        },
      );
    }
    return {
      answer: { deliveryId, status: row.status },
      fire: row.status === 'accepted' ? { deliveryRowId: row.id } : null,
    };
  }

  /** The secrets that may have signed a delivery now: current, and previous in its grace (D17). */
  private openSecrets(trigger: InboundTrigger, now: Date): string[] {
    const sealed = [trigger.secret];
    if (
      trigger.previousSecret &&
      trigger.previousSecretUntil &&
      trigger.previousSecretUntil > now
    )
      sealed.push(trigger.previousSecret);
    const open: string[] = [];
    for (const value of sealed) {
      try {
        open.push(this.secrets.open(value));
      } catch {
        // Fails closed: an unopenable secret verifies nothing. Never logs the value.
        this.logger.error(
          `trigger ${trigger.id}: a stored secret cannot be opened (APP_ENCRYPTION_KEY missing or changed)`,
        );
      }
    }
    return open;
  }

  private decide(
    trigger: InboundTrigger,
    deliveryId: string,
    input: HookRequest,
    now: Date,
  ): Promise<Decision> {
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<
        { enabled: boolean; bucketTokens: number; bucketRefilledAt: Date }[]
      >`SELECT "enabled", "bucketTokens", "bucketRefilledAt"
          FROM "inbound_triggers" WHERE "id" = ${trigger.id} FOR UPDATE`;
      if (!locked?.enabled) return { kind: 'gone' };

      const seen = await tx.inboundDelivery.findUnique({
        where: { triggerId_deliveryId: { triggerId: trigger.id, deliveryId } },
        select: { id: true },
      });
      if (seen) return { kind: 'replayed' };

      // D6: every verified, new delivery spends a token — a 422 too.
      const taken = take(
        { tokens: locked.bucketTokens, refilledAt: locked.bucketRefilledAt },
        now,
      );
      if (!taken.ok) return { kind: 'limited' };
      await tx.inboundTrigger.update({
        where: { id: trigger.id },
        data: {
          bucketTokens: taken.bucket.tokens,
          bucketRefilledAt: taken.bucket.refilledAt,
        },
      });

      const record = (
        status: InboundDeliveryStatus,
        extra: { reason?: string; renderedArgs?: string } = {},
      ) =>
        tx.inboundDelivery.create({
          data: {
            triggerId: trigger.id,
            deliveryId,
            receivedAt: now,
            status,
            sourceIp: input.sourceIp,
            ...extra,
          },
        });

      const body = parseRawJson(input.rawBody);
      if (!body.ok) {
        const row = await record('rejected', { reason: INVALID_JSON_REASON });
        return { kind: 'recorded', row, invalid: { reason: null } };
      }
      const action = parseAction(trigger.action);
      let renderedArgs: string | undefined;
      if (action.kind === 'skill') {
        const rendered = renderArgsTemplate(
          action.args,
          body.value,
          trigger.allowedPaths,
          trigger.valuePattern,
        );
        if (!rendered.ok) {
          const row = await record('rejected', { reason: rendered.reason });
          return {
            kind: 'recorded',
            row,
            invalid: { reason: rendered.reason, path: rendered.path },
          };
        }
        renderedArgs = rendered.args;
      }

      // D5: the creator's authority now, not when the trigger was saved.
      const creator = trigger.createdById
        ? await tx.user.findUnique({
            where: { id: trigger.createdById },
            select: { role: true, status: true },
          })
        : null;
      if (creator?.role !== 'admin' || creator.status !== 'active') {
        const row = await record('failed', {
          reason: INBOUND_DELIVERY_REASONS.creatorNotAuthorized,
          ...(renderedArgs !== undefined ? { renderedArgs } : {}),
        });
        return { kind: 'recorded', row, creatorRevoked: true };
      }

      // D6: one live run per trigger — a run still going, or a firing not settled yet.
      const live = await tx.inboundDelivery.findFirst({
        where: {
          triggerId: trigger.id,
          OR: [
            { status: 'started', run: { status: 'running' } },
            {
              status: 'accepted',
              receivedAt: { gt: new Date(now.getTime() - ACCEPTED_LIVE_MS) },
            },
          ],
        },
        select: { id: true },
      });
      if (live) {
        const row = await record('skipped', {
          reason: INBOUND_DELIVERY_REASONS.previousStillRunning,
          ...(renderedArgs !== undefined ? { renderedArgs } : {}),
        });
        return { kind: 'recorded', row };
      }

      const row = await record(
        'accepted',
        renderedArgs !== undefined ? { renderedArgs } : {},
      );
      return { kind: 'recorded', row };
    });
  }

  /** D5: disables the trigger on the system's behalf, audited. */
  private async disableForCreator(
    trigger: InboundTrigger,
    delivery: InboundDelivery,
  ): Promise<void> {
    const reason = INBOUND_DELIVERY_REASONS.creatorNotAuthorized;
    const { count } = await this.prisma.inboundTrigger.updateMany({
      where: { id: trigger.id, enabled: true },
      data: { enabled: false, disabledReason: reason },
    });
    if (count === 0) return;
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'trigger.update',
      target: { type: 'trigger', id: trigger.id },
      projectId: trigger.projectId,
      before: { enabled: true },
      after: { enabled: false, disabledReason: reason },
      result: 'ok',
      meta: {
        deliveryId: delivery.deliveryId,
        createdById: trigger.createdById,
      },
    });
  }
}
