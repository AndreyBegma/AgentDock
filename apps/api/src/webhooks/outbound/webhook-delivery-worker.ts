import {
  WEBHOOK_ATTEMPT_ERRORS,
  WEBHOOK_CIRCUIT_OPEN_MS,
  WEBHOOK_CLAIM_BATCH,
  WEBHOOK_HEADERS,
  WEBHOOK_WORKER_INTERVAL_MS,
  type WebhookCircuitState,
} from '@agentdock/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { WebhookDelivery } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../../database/prisma.service';
import {
  type GuardedPostResult,
  guardedPost,
  signOutbound,
  type TargetAllowlist,
  WEBHOOKS_OPTIONS,
  WebhookSecrets,
  WebhookSettingsService,
  type WebhooksOptions,
} from '../common';
import { circuitAfterAttempt, deliveryAfterAttempt } from './delivery-policy';
import { WebhookLive } from './webhook-live';

/** D12: the session-level advisory lock only the delivering instance holds. */
const LEADER_LOCK = 'agentdock.webhooks.worker';
/** A follower retries the lock this often. */
const LEADER_RETRY_MS = 30_000;
/**
 * A claimed delivery is pushed this far past the request timeout, so a worker
 * that dies mid-attempt leaves it to be retried, not lost. A half-open probe
 * that outlives it is taken as dead and another probe is allowed.
 */
const CLAIM_LEASE_EXTRA_MS = 60_000;
const USER_AGENT = 'AgentDock-Webhooks/1';

interface ClaimRow {
  id: string;
  webhookId: string;
  circuitState: WebhookCircuitState;
}

interface CircuitRow {
  circuitState: WebhookCircuitState;
  circuitOpenedAt: Date | null;
  consecutiveFailures: number;
}

/** One attempt's outcome before it is written. */
interface Attempt {
  result: GuardedPostResult;
  /** False when the failure is not the receiver's (D14 does not count it). */
  counts: boolean;
}

/**
 * The outbound delivery worker (docs/specs/26-webhooks.md D12–D15). One API
 * instance — the one holding `pg_try_advisory_lock` on its own connection —
 * claims due deliveries every 5 s with `FOR UPDATE SKIP LOCKED`, pushes each
 * claimed one's `nextAttemptAt` past a lease, and sends them after the claim
 * commits: signed anew (D13), through `guardedPost` (D15: send-time
 * resolution, pinned address, no redirects, 10 s, 2 KB of response). A
 * webhook whose circuit is open is not claimed until its 15 minutes pass; then
 * exactly one delivery is claimed as the half-open probe (D14).
 */
@Injectable()
export class WebhookDeliveryWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WebhookDeliveryWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private lock: Client | null = null;
  private lastAttempt = 0;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: WebhookSecrets,
    private readonly settings: WebhookSettingsService,
    private readonly live: WebhookLive,
    @Inject(WEBHOOKS_OPTIONS) private readonly options: WebhooksOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.workerEnabled) return;
    this.timer = setInterval(() => {
      void this.loop().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`webhook delivery tick failed: ${reason}`);
      });
    }, WEBHOOK_WORKER_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    const client = this.lock;
    this.lock = null;
    await client?.end().catch(() => undefined);
  }

  /** Takes the leader lock if it is free; true while this instance holds it. */
  async lead(): Promise<boolean> {
    if (this.lock) return true;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await client.connect();
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [LEADER_LOCK],
      );
      if (!result.rows[0]?.locked) {
        await client.end();
        return false;
      }
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    // A dropped connection drops the lock with it: stop delivering.
    client.on('error', (error) => {
      this.logger.warn(`webhook worker lock connection lost: ${error.message}`);
      if (this.lock === client) this.lock = null;
    });
    client.on('end', () => {
      if (this.lock === client) this.lock = null;
    });
    this.lock = client;
    this.logger.log('webhook delivery leadership taken');
    return true;
  }

  private async loop(): Promise<void> {
    if (!this.lock) {
      const now = Date.now();
      if (now - this.lastAttempt < LEADER_RETRY_MS) return;
      this.lastAttempt = now;
      if (!(await this.lead())) return;
    }
    await this.tick();
  }

  /**
   * One pass: claims due deliveries and attempts each once. Returns how many
   * it attempted; `null` when a pass is already running. The timer calls it
   * only while this instance leads; tests call it directly.
   */
  async tick(
    now = new Date(),
    random: () => number = Math.random,
  ): Promise<number | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const claimed = await this.claim(now);
      if (claimed.length === 0) return 0;
      const allowlist = await this.settings.allowlist();
      await Promise.all(
        claimed.map((id) =>
          this.deliver(id, allowlist, now, random).catch((error: unknown) => {
            const reason =
              error instanceof Error ? error.message : String(error);
            this.logger.error(`webhook delivery ${id} failed: ${reason}`);
          }),
        ),
      );
      return claimed.length;
    } finally {
      this.running = false;
    }
  }

  /** D12 + D14: the ids of the deliveries this pass attempts. */
  private claim(now: Date): Promise<string[]> {
    const lease = this.options.requestTimeoutMs + CLAIM_LEASE_EXTRA_MS;
    const openBefore = new Date(now.getTime() - WEBHOOK_CIRCUIT_OPEN_MS);
    const probeBefore = new Date(now.getTime() - lease);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ClaimRow[]>`
        SELECT d.id, d."webhookId", w."circuitState"::text AS "circuitState"
          FROM webhook_deliveries d
          JOIN webhooks w ON w.id = d."webhookId"
         WHERE d.status = 'pending' AND d."nextAttemptAt" <= ${now}
           AND w.enabled
           AND (w."circuitState" = 'closed'
                OR (w."circuitState" = 'open'
                    AND COALESCE(w."circuitOpenedAt", to_timestamp(0)) <= ${openBefore})
                OR (w."circuitState" = 'half_open'
                    AND COALESCE(w."circuitOpenedAt", to_timestamp(0)) <= ${probeBefore}))
         ORDER BY d."nextAttemptAt", d.id
         LIMIT ${WEBHOOK_CLAIM_BATCH}
           FOR UPDATE OF d SKIP LOCKED`;

      const ids: string[] = [];
      const probed = new Set<string>();
      for (const row of rows) {
        if (row.circuitState === 'closed') {
          ids.push(row.id);
          continue;
        }
        // One half-open probe per webhook; its other deliveries stay held.
        if (probed.has(row.webhookId)) continue;
        probed.add(row.webhookId);
        const { count } = await tx.webhook.updateMany({
          where: { id: row.webhookId, circuitState: row.circuitState },
          data: { circuitState: 'half_open', circuitOpenedAt: now },
        });
        if (count === 1) ids.push(row.id);
      }
      if (ids.length > 0) {
        await tx.webhookDelivery.updateMany({
          where: { id: { in: ids } },
          data: { nextAttemptAt: new Date(now.getTime() + lease) },
        });
      }
      return ids;
    });
  }

  /** One attempt of one claimed delivery, and its outcome written. */
  private async deliver(
    id: string,
    allowlist: TargetAllowlist,
    now: Date,
    random: () => number,
  ): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id },
      include: { webhook: { select: { url: true, secret: true } } },
    });
    if (!delivery || delivery.status !== 'pending') return;
    const attempt = await this.attempt(delivery, delivery.webhook, allowlist);
    await this.record(delivery, attempt, now, random);
  }

  private async attempt(
    delivery: WebhookDelivery,
    webhook: { url: string; secret: string },
    allowlist: TargetAllowlist,
  ): Promise<Attempt> {
    let secret: string;
    try {
      secret = this.secrets.open(webhook.secret);
    } catch {
      return {
        counts: false,
        result: {
          succeeded: false,
          status: null,
          body: null,
          error: WEBHOOK_ATTEMPT_ERRORS.secretUnavailable,
        },
      };
    }
    const body = JSON.stringify(delivery.payload);
    const result = await guardedPost({
      url: webhook.url,
      body,
      headers: {
        'User-Agent': USER_AGENT,
        [WEBHOOK_HEADERS.event]: delivery.eventType,
        [WEBHOOK_HEADERS.delivery]: delivery.id,
        [WEBHOOK_HEADERS.signature]: signOutbound(secret, body),
      },
      allowlist,
      resolve: this.options.resolve,
      timeoutMs: this.options.requestTimeoutMs,
    });
    return { result, counts: true };
  }

  /** Writes the attempt and moves the webhook's circuit, under its row lock. */
  private async record(
    delivery: WebhookDelivery,
    { result, counts }: Attempt,
    now: Date,
    random: () => number,
  ): Promise<void> {
    const attempts = delivery.attempts + 1;
    const next = deliveryAfterAttempt(result.succeeded, attempts, now, random);
    const written = await this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<CircuitRow[]>`
        SELECT "circuitState"::text AS "circuitState", "circuitOpenedAt",
               "consecutiveFailures"
          FROM webhooks WHERE id = ${delivery.webhookId} FOR UPDATE`;
      // Deleted with its webhook while the attempt was in flight.
      if (!current) return null;
      const circuit = circuitAfterAttempt(
        current,
        { succeeded: result.succeeded, counts },
        now,
      );
      await tx.webhook.update({
        where: { id: delivery.webhookId },
        data: circuit,
      });
      const row = await tx.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: next.status,
          nextAttemptAt: next.nextAttemptAt,
          attempts,
          lastAttemptAt: now,
          responseCode: result.status,
          responseBody: result.body,
          error: result.error,
        },
      });
      if (circuit.circuitState === 'open' && current.circuitState !== 'open') {
        this.logger.warn(
          `webhook ${delivery.webhookId} circuit opened after ${circuit.consecutiveFailures} consecutive failures`,
        );
      }
      return { row, circuitState: circuit.circuitState };
    });
    if (written) this.live.delivery(written.row, written.circuitState);
  }
}
