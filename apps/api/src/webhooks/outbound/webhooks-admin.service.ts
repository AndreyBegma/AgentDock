import {
  buildWebhookEnvelope,
  WEBHOOK_DELIVERY_PAGE_SIZE,
  WEBHOOKS_ERROR,
  type WebhookDeliveryPage,
  type WebhookDeliveryView,
  type WebhookView,
  type WebhookWithSecret,
} from '@agentdock/shared';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { decodeKeyset, encodeKeyset } from '../../activity';
import { AuditService } from '../../audit/audit.service';
import type { AuditContext } from '../../audit/audit.types';
import { PrismaService } from '../../database/prisma.service';
import {
  checkWebhookTarget,
  WEBHOOKS_OPTIONS,
  WebhookSecrets,
  WebhookSettingsService,
  type WebhooksOptions,
  webhooksError,
} from '../common';
import type {
  WebhookCreateDto,
  WebhookDeliveriesQuery,
  WebhookUpdateDto,
} from './dto';
import { WebhookLive } from './webhook-live';
import {
  toDeliveryView,
  toWebhookView,
  WEBHOOK_VIEW_SELECT,
  webhookAuditState,
} from './webhook-mapper';

const TEST_MESSAGE = 'Test delivery from AgentDock';

/** A webhook's columns for a view, with its newest delivery. */
const VIEW_SELECT = {
  ...WEBHOOK_VIEW_SELECT,
  deliveries: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { status: true, createdAt: true, responseCode: true },
  },
} satisfies Prisma.WebhookSelect;

type ViewRow = Prisma.WebhookGetPayload<{ select: typeof VIEW_SELECT }>;

const view = ({ deliveries, ...row }: ViewRow): WebhookView =>
  toWebhookView(row, deliveries[0] ?? null);

const notFound = (what: string) =>
  webhooksError(404, WEBHOOKS_ERROR.notFound, `${what} not found`);

/**
 * `/admin/webhooks*` (docs/specs/26-webhooks.md "API", D14–D17, D19). Every
 * change is audited; the secret is returned only by create and rotate, and
 * never reaches a view, a log or an audit value.
 */
@Injectable()
export class WebhooksAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: WebhookSecrets,
    private readonly settings: WebhookSettingsService,
    private readonly audit: AuditService,
    private readonly live: WebhookLive,
    @Inject(WEBHOOKS_OPTIONS) private readonly options: WebhooksOptions,
  ) {}

  async list(): Promise<WebhookView[]> {
    const rows = await this.prisma.webhook.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: VIEW_SELECT,
    });
    return rows.map(view);
  }

  async get(id: string): Promise<WebhookView> {
    return view(await this.find(id));
  }

  async create(
    dto: WebhookCreateDto,
    userId: string,
    ctx: AuditContext,
  ): Promise<WebhookWithSecret> {
    await this.checkUrl(dto.url);
    await this.checkProjects(dto.projectIds);
    const issued = this.secrets.issue();
    const row = await this.prisma.webhook.create({
      data: {
        name: dto.name,
        url: dto.url,
        events: dto.events,
        projectIds: dto.projectIds,
        secret: issued.sealed,
        createdById: userId,
      },
      select: VIEW_SELECT,
    });
    await this.record(ctx, 'webhook.create', row.id, {
      after: webhookAuditState(row),
    });
    return { ...view(row), secret: issued.secret };
  }

  async update(
    id: string,
    dto: WebhookUpdateDto,
    ctx: AuditContext,
  ): Promise<WebhookView> {
    const before = await this.find(id);
    if (dto.url !== undefined && dto.url !== before.url)
      await this.checkUrl(dto.url);
    if (dto.projectIds !== undefined) await this.checkProjects(dto.projectIds);
    const row = await this.prisma.webhook.update({
      where: { id },
      data: {
        name: dto.name,
        url: dto.url,
        events: dto.events,
        projectIds: dto.projectIds,
        enabled: dto.enabled,
      },
      select: VIEW_SELECT,
    });
    await this.record(ctx, 'webhook.update', id, {
      before: webhookAuditState(before),
      after: webhookAuditState(row),
    });
    return view(row);
  }

  /** Deletes the webhook and, by cascade, its delivery log. */
  async remove(id: string, ctx: AuditContext): Promise<void> {
    const before = await this.find(id);
    await this.prisma.webhook.delete({ where: { id } });
    await this.record(ctx, 'webhook.delete', id, {
      before: webhookAuditState(before),
    });
  }

  /** D17: a new secret, shown once; outbound signing switches at once. */
  async rotateSecret(
    id: string,
    ctx: AuditContext,
  ): Promise<WebhookWithSecret> {
    await this.find(id);
    const issued = this.secrets.issue();
    const row = await this.prisma.webhook.update({
      where: { id },
      data: { secret: issued.sealed },
      select: VIEW_SELECT,
    });
    await this.record(ctx, 'webhook.rotate_secret', id, {});
    return { ...view(row), secret: issued.secret };
  }

  /** D14: closes the circuit by hand; held deliveries go out on the next tick. */
  async closeCircuit(id: string, ctx: AuditContext): Promise<WebhookView> {
    const before = await this.find(id);
    const row = await this.prisma.webhook.update({
      where: { id },
      data: {
        circuitState: 'closed',
        circuitOpenedAt: null,
        consecutiveFailures: 0,
      },
      select: VIEW_SELECT,
    });
    await this.record(ctx, 'webhook.circuit_close', id, {
      before: {
        circuitState: before.circuitState,
        consecutiveFailures: before.consecutiveFailures,
      },
      after: { circuitState: 'closed', consecutiveFailures: 0 },
    });
    return view(row);
  }

  /** Enqueues a `webhook.test` delivery, due now. */
  async test(id: string, ctx: AuditContext): Promise<WebhookDeliveryView> {
    const webhook = await this.find(id);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.webhookDelivery.create({
        data: { webhookId: id, eventType: 'webhook.test', payload: {} },
      });
      // The envelope's id carries the delivery id, known only now.
      const envelope = buildWebhookEnvelope({
        id: `test_${created.id}`,
        type: 'webhook.test',
        ts: created.createdAt,
        project: null,
        data: { message: TEST_MESSAGE },
      });
      return tx.webhookDelivery.update({
        where: { id: created.id },
        data: { payload: envelope as unknown as Prisma.InputJsonObject },
      });
    });
    await this.record(ctx, 'webhook.test', id, {
      meta: { deliveryId: row.id },
    });
    this.live.delivery(row, webhook.circuitState);
    return toDeliveryView(row);
  }

  /**
   * A new attempt now: the same payload, signed anew when it is sent. The
   * attempt count keeps counting, so a `failed` delivery gets one more try.
   * An open circuit still holds it.
   */
  async redeliver(
    id: string,
    deliveryId: string,
    ctx: AuditContext,
  ): Promise<WebhookDeliveryView> {
    const webhook = await this.find(id);
    const existing = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, webhookId: id },
      select: { status: true },
    });
    if (!existing) throw notFound('Delivery');
    const row = await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'pending', nextAttemptAt: new Date(), error: null },
    });
    await this.record(ctx, 'webhook.redeliver', id, {
      before: { status: existing.status },
      meta: { deliveryId },
    });
    this.live.delivery(row, webhook.circuitState);
    return toDeliveryView(row);
  }

  /** The delivery log, newest first, keyset-paged. */
  async deliveries(
    id: string,
    query: WebhookDeliveriesQuery,
  ): Promise<WebhookDeliveryPage> {
    await this.find(id);
    const where: Prisma.WebhookDeliveryWhereInput = { webhookId: id };
    if (query.status) where.status = query.status;
    if (query.cursor) {
      const key = decodeKeyset(query.cursor);
      if (!key)
        throw new BadRequestException('The cursor is not one this API issued');
      where.OR = [
        { createdAt: { lt: key.at } },
        { createdAt: key.at, id: { lt: key.id } },
      ];
    }
    const rows = await this.prisma.webhookDelivery.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: WEBHOOK_DELIVERY_PAGE_SIZE + 1,
    });
    const page = rows.slice(0, WEBHOOK_DELIVERY_PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      items: page.map(toDeliveryView),
      nextCursor:
        rows.length > WEBHOOK_DELIVERY_PAGE_SIZE && last
          ? encodeKeyset({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  private async find(id: string): Promise<ViewRow> {
    const row = await this.prisma.webhook.findUnique({
      where: { id },
      select: VIEW_SELECT,
    });
    if (!row) throw notFound('Webhook');
    return row;
  }

  /** D15 at save time: the same check every attempt makes again. */
  private async checkUrl(url: string): Promise<void> {
    const check = await checkWebhookTarget(
      url,
      await this.settings.allowlist(),
      this.options.resolve,
    );
    if (check.ok) return;
    switch (check.error) {
      case 'invalid_url':
        throw webhooksError(
          422,
          WEBHOOKS_ERROR.invalidUrl,
          'The URL must be an absolute http(s) URL without credentials',
        );
      case 'https_required':
        throw webhooksError(
          422,
          WEBHOOKS_ERROR.httpsRequired,
          'Plain http is allowed only to an allowlisted private target',
        );
      case 'unresolvable':
        throw webhooksError(
          422,
          WEBHOOKS_ERROR.unresolvable,
          'The host does not resolve',
        );
      case 'blocked_address':
        throw webhooksError(
          422,
          WEBHOOKS_ERROR.blockedAddress,
          `The host resolves to a refused address${check.address ? ` (${check.address})` : ''}`,
        );
    }
  }

  private async checkProjects(projectIds: readonly string[]): Promise<void> {
    if (projectIds.length === 0) return;
    const found = await this.prisma.project.count({
      where: { id: { in: [...projectIds] } },
    });
    if (found !== projectIds.length) throw notFound('Project');
  }

  private record(
    ctx: AuditContext,
    action:
      | 'webhook.create'
      | 'webhook.update'
      | 'webhook.delete'
      | 'webhook.rotate_secret'
      | 'webhook.test'
      | 'webhook.redeliver'
      | 'webhook.circuit_close',
    id: string,
    values: { before?: object; after?: object; meta?: object },
  ): Promise<void> {
    return this.audit.record({
      ...ctx,
      action,
      target: { type: 'webhook', id },
      ...values,
      result: 'ok',
    });
  }
}
