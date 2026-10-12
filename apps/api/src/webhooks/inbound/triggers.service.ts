import {
  type AuditAction,
  INBOUND_DETAIL_DELIVERIES,
  type InboundDryRunResult,
  type InboundTriggerDetail,
  type InboundTriggerView,
  type InboundTriggerWithSecret,
  PREVIOUS_SECRET_GRACE_MS,
  renderArgsTemplate,
  WEBHOOKS_ERROR,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { InboundTrigger, Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import type { AuditContext } from '../../audit/audit.types';
import { PrismaService } from '../../database/prisma.service';
import { newTriggerPublicId, WebhookSecrets, webhooksError } from '../common';
import type { TriggerCreateDto, TriggerUpdateDto } from './dto';
import { fullBucket } from './token-bucket';
import { checkTemplate, parseAction } from './trigger-action';
import { auditable, toDeliveryView, toTriggerView } from './trigger-mapper';

/** Who calls a mutating route, as the route resolved them. */
export interface TriggerCaller {
  userId: string;
  ctx: AuditContext;
}

/** Disabled by an admin through `PATCH { enabled: false }`. */
export const MANUAL_DISABLE = 'manual';

const LAST_DELIVERY = {
  deliveries: { orderBy: { id: 'desc' }, take: 1 },
} satisfies Prisma.InboundTriggerInclude;

const triggerNotFound = () =>
  webhooksError(404, WEBHOOKS_ERROR.notFound, 'Trigger not found');

/**
 * Inbound triggers, admin only (D16): create, edit, enable/disable, delete,
 * rotate the secret and dry-run a payload — each change audited (D19). A
 * secret leaves this service only in the create and rotate answers (D17).
 */
@Injectable()
export class TriggersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly secrets: WebhookSecrets,
  ) {}

  async list(): Promise<InboundTriggerView[]> {
    const rows = await this.prisma.inboundTrigger.findMany({
      include: LAST_DELIVERY,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(({ deliveries, ...row }) =>
      toTriggerView(row, deliveries[0] ?? null),
    );
  }

  async detail(id: string): Promise<InboundTriggerDetail> {
    const row = await this.prisma.inboundTrigger.findUnique({
      where: { id },
      include: {
        deliveries: {
          orderBy: { id: 'desc' },
          take: INBOUND_DETAIL_DELIVERIES,
        },
      },
    });
    if (!row) throw triggerNotFound();
    const { deliveries, ...trigger } = row;
    return {
      ...toTriggerView(trigger, deliveries[0] ?? null),
      deliveries: deliveries.map(toDeliveryView),
    };
  }

  async create(
    dto: TriggerCreateDto,
    caller: TriggerCaller,
  ): Promise<InboundTriggerWithSecret> {
    const action = parseAction(dto.action);
    const valuePattern = dto.valuePattern ?? null;
    checkTemplate(action, dto.allowedPaths, valuePattern);
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      select: { id: true },
    });
    if (!project) {
      throw webhooksError(404, WEBHOOKS_ERROR.notFound, 'Project not found');
    }
    const issued = this.secrets.issue();
    const bucket = fullBucket(new Date());
    const row = await this.prisma.inboundTrigger.create({
      data: {
        publicId: newTriggerPublicId(),
        name: dto.name,
        projectId: dto.projectId,
        action,
        allowedPaths: dto.allowedPaths,
        valuePattern,
        secret: issued.sealed,
        bucketTokens: bucket.tokens,
        bucketRefilledAt: bucket.refilledAt,
        createdById: caller.userId,
      },
    });
    await this.record(caller, 'trigger.create', row, {
      after: auditable(row),
    });
    return { ...toTriggerView(row, null), secret: issued.secret };
  }

  async update(
    id: string,
    dto: TriggerUpdateDto,
    caller: TriggerCaller,
  ): Promise<InboundTriggerView> {
    const before = await this.find(id);
    const action =
      dto.action !== undefined
        ? parseAction(dto.action)
        : parseAction(before.action);
    const allowedPaths = dto.allowedPaths ?? before.allowedPaths;
    const valuePattern =
      dto.valuePattern !== undefined ? dto.valuePattern : before.valuePattern;
    // The pair is checked whole: narrowing `allowedPaths` alone can orphan a placeholder.
    checkTemplate(action, allowedPaths, valuePattern);

    const enabledChange =
      dto.enabled === undefined || dto.enabled === before.enabled
        ? {}
        : dto.enabled
          ? { enabled: true, disabledReason: null }
          : { enabled: false, disabledReason: MANUAL_DISABLE };
    const row = await this.prisma.inboundTrigger.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.action !== undefined ? { action } : {}),
        ...(dto.allowedPaths !== undefined ? { allowedPaths } : {}),
        ...(dto.valuePattern !== undefined ? { valuePattern } : {}),
        ...enabledChange,
      },
      include: LAST_DELIVERY,
    });
    const { deliveries, ...trigger } = row;
    await this.record(caller, 'trigger.update', trigger, {
      before: auditable(before),
      after: auditable(trigger),
    });
    return toTriggerView(trigger, deliveries[0] ?? null);
  }

  async remove(id: string, caller: TriggerCaller): Promise<void> {
    const before = await this.find(id);
    await this.prisma.inboundTrigger.delete({ where: { id } });
    await this.record(caller, 'trigger.delete', before, {
      before: auditable(before),
    });
  }

  /** D17: a new secret now; the old one still verifies for 24 hours. */
  async rotateSecret(
    id: string,
    caller: TriggerCaller,
  ): Promise<InboundTriggerWithSecret> {
    const before = await this.find(id);
    const issued = this.secrets.issue();
    const previousSecretUntil = new Date(Date.now() + PREVIOUS_SECRET_GRACE_MS);
    const row = await this.prisma.inboundTrigger.update({
      where: { id },
      data: {
        secret: issued.sealed,
        previousSecret: before.secret,
        previousSecretUntil,
      },
      include: LAST_DELIVERY,
    });
    const { deliveries, ...trigger } = row;
    await this.record(caller, 'trigger.rotate_secret', trigger, {
      after: { previousSecretUntil: previousSecretUntil.toISOString() },
    });
    return {
      ...toTriggerView(trigger, deliveries[0] ?? null),
      secret: issued.secret,
    };
  }

  /** The D4 verdict the hook would give `payload`; nothing fires, nothing is recorded. */
  async dryRun(id: string, payload: unknown): Promise<InboundDryRunResult> {
    const row = await this.find(id);
    const action = parseAction(row.action);
    if (action.kind !== 'skill') return { ok: true, args: null };
    const rendered = renderArgsTemplate(
      action.args,
      payload,
      row.allowedPaths,
      row.valuePattern,
    );
    if (rendered.ok) return { ok: true, args: rendered.args };
    return {
      ok: false,
      error: WEBHOOKS_ERROR.invalidPayload,
      reason: rendered.reason,
      ...(rendered.path !== undefined ? { path: rendered.path } : {}),
    };
  }

  private async find(id: string): Promise<InboundTrigger> {
    const row = await this.prisma.inboundTrigger.findUnique({ where: { id } });
    if (!row) throw triggerNotFound();
    return row;
  }

  private record(
    caller: TriggerCaller,
    action: AuditAction,
    row: InboundTrigger,
    change: { before?: object; after?: object },
  ) {
    return this.audit.record({
      ...caller.ctx,
      action,
      target: { type: 'trigger', id: row.id },
      projectId: row.projectId,
      ...change,
      result: 'ok',
    });
  }
}
