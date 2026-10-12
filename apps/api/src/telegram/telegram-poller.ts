import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Client } from 'pg';
import { PrismaService } from '../database/prisma.service';
import { BotTokenStore } from '../notifications';
import {
  redactToken,
  TelegramApiError,
  TelegramClient,
} from './telegram-client';
import { TelegramDeliveryService } from './telegram-delivery.service';
import {
  LINK_REPLIES,
  TelegramLinkingService,
} from './telegram-linking.service';
import { TELEGRAM_OPTIONS, type TelegramOptions } from './telegram-options';

/** Session advisory lock: held by the one API instance that talks to Telegram. */
const LOCK_KEY = 'telegram:poller';
/** `notification_matcher_state` is a single row; the matcher creates it. */
const STATE_ID = 1;
/** A heartbeat line every this many polls (about 30 min at the 30 s timeout). */
const HEARTBEAT_EVERY = 60;
/** Leadership is retried this often by an instance that did not get it. */
const FOLLOWER_RETRY_MS = 30_000;
/** An empty long poll faster than this did not long-poll. */
const MIN_EMPTY_POLL_MS = 1_000;

export interface PollerHealth {
  /** This instance holds the lock and its loop is running. */
  polling: boolean;
  lastError: string | null;
  lastPollAt: Date | null;
}

/** What one `pollOnce` did, and how long the loop should wait before the next. */
export type PollResult =
  | { status: 'polled'; updates: number }
  | { status: 'idle'; waitMs: number }
  | { status: 'error'; waitMs: number };

/**
 * An error's text for a log line or `lastError`. A `TelegramApiError` is
 * already redacted; anything else (a database error) goes through the
 * redactor too, in case it quotes a URL.
 */
const safeMessage = (error: unknown, token?: string): string => {
  if (error instanceof TelegramApiError) return error.message;
  const text = error instanceof Error ? error.message : String(error);
  return redactToken(text.slice(0, 300), token);
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * The Telegram side of the API (spec 22 D7): long polling, not a webhook, so
 * a home server behind NAT needs only outbound HTTPS. Exactly one instance
 * polls: a session-level `pg_try_advisory_lock` on a connection of its own.
 * The lock lives exactly as long as that connection, so a crashed instance
 * frees it, and a 30 s long poll never pins a pooled Prisma connection.
 *
 * The leader runs two loops: `getUpdates` for `/start` and `/stop`, with the
 * offset in `notification_matcher_state.telegramUpdateOffset`, and the
 * delivery timer. Neither starts under `APP_ENV=test`; suites call
 * `acquire()`, `pollOnce()` and `TelegramDeliveryService.deliverOnce()`.
 */
@Injectable()
export class TelegramPoller implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramPoller.name);
  private readonly abort = new AbortController();
  private lockClient: Client | null = null;
  private loopRunning = false;
  private deliveryTimer: NodeJS.Timeout | undefined;
  private delivering = false;
  /** The offset when the state row does not exist yet (first seconds of a fresh database). */
  private offset = 0n;
  /** Bumped when the bot changes: a poll begun before it is discarded. */
  private generation = 0;
  private polls = 0;
  private lastError: string | null = null;
  private lastPollAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: BotTokenStore,
    private readonly client: TelegramClient,
    private readonly linking: TelegramLinkingService,
    private readonly delivery: TelegramDeliveryService,
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoStart) return;
    void this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.abort.abort();
    clearInterval(this.deliveryTimer);
    await this.release();
  }

  health(): PollerHealth {
    return {
      polling: this.isLeader && this.loopRunning,
      lastError: this.lastError,
      lastPollAt: this.lastPollAt,
    };
  }

  get isLeader(): boolean {
    return this.lockClient !== null;
  }

  /** Takes the poller lock if no other instance holds it. */
  async acquire(): Promise<boolean> {
    if (this.lockClient) return true;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    // A dropped connection drops the lock with it: step down.
    const stepDown = () => {
      if (this.lockClient !== client) return;
      this.lockClient = null;
      this.logger.warn('lost the Telegram poller lock connection');
    };
    client.on('error', stepDown);
    client.on('end', stepDown);
    await client.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [LOCK_KEY],
      );
      if (rows[0]?.locked) {
        this.lockClient = client;
        return true;
      }
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    await client.end();
    return false;
  }

  /** Gives the lock up; closing the connection frees it. */
  async release(): Promise<void> {
    const client = this.lockClient;
    this.lockClient = null;
    await client?.end().catch(() => undefined);
  }

  /**
   * After the bot changed (the caller zeroes the stored offset): its update
   * ids start over, so the old offset would hide them. A poll already in
   * flight under the old token is discarded.
   */
  forgetOffset(): void {
    this.generation += 1;
    this.offset = 0n;
  }

  /** One long poll and the replies to what it brought. */
  async pollOnce(signal?: AbortSignal): Promise<PollResult> {
    const bot = await this.tokens.read();
    if (!bot.ok) {
      this.lastError =
        bot.reason === 'not_configured' ? null : `bot token ${bot.reason}`;
      return { status: 'idle', waitMs: this.options.idleMs };
    }
    const generation = this.generation;
    try {
      const offset = await this.currentOffset();
      const updates = await this.client.getUpdates(
        bot.token,
        Number(offset),
        this.options.pollTimeoutS,
        signal,
      );
      if (generation !== this.generation)
        return { status: 'polled', updates: 0 };
      for (const update of updates) {
        if (generation !== this.generation) break;
        const answer = await this.linking.handleUpdate(update);
        if (answer) {
          await this.client
            .sendMessage(
              bot.token,
              answer.chatId,
              LINK_REPLIES[answer.reply],
              true,
            )
            .catch((error: unknown) => {
              this.logger.warn(
                `Telegram reply failed: ${safeMessage(error, bot.token)}`,
              );
            });
        }
        await this.storeOffset(BigInt(update.update_id) + 1n);
      }
      this.lastError = null;
      this.lastPollAt = new Date();
      this.polls += 1;
      if (this.polls % HEARTBEAT_EVERY === 0) {
        this.logger.log(`Telegram poller alive (${this.polls} polls)`);
      }
      return { status: 'polled', updates: updates.length };
    } catch (error) {
      const message = safeMessage(error, bot.token);
      this.logger.warn(`Telegram poll failed: ${message}`);
      this.lastError = message;
      const retryAfterMs =
        error instanceof TelegramApiError && error.retryAfterS !== undefined
          ? error.retryAfterS * 1000
          : 0;
      return {
        status: 'error',
        waitMs: Math.max(retryAfterMs, this.options.idleMs),
      };
    }
  }

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      if (!this.isLeader) {
        this.loopRunning = false;
        clearInterval(this.deliveryTimer);
        const leader = await this.acquire().catch((error: unknown) => {
          this.logger.warn(
            `Telegram poller lock unavailable: ${safeMessage(error)}`,
          );
          return false;
        });
        if (!leader) {
          await sleep(FOLLOWER_RETRY_MS, signal);
          continue;
        }
        this.logger.log('Telegram poller lock acquired');
        this.startDelivery();
      }
      this.loopRunning = true;
      const started = Date.now();
      const result = await this.pollOnce(signal);
      if (result.status !== 'polled') {
        await sleep(result.waitMs, signal);
      } else if (
        result.updates === 0 &&
        Date.now() - started < MIN_EMPTY_POLL_MS
      ) {
        // A long poll that came back empty at once did not wait: do not spin.
        await sleep(this.options.idleMs, signal);
      }
    }
    this.loopRunning = false;
  }

  private startDelivery(): void {
    clearInterval(this.deliveryTimer);
    this.deliveryTimer = setInterval(() => {
      if (this.delivering || !this.isLeader) return;
      this.delivering = true;
      void this.delivery
        .deliverOnce()
        .catch((error: unknown) => {
          this.logger.error(
            `Telegram delivery pass failed: ${safeMessage(error)}`,
          );
        })
        .finally(() => {
          this.delivering = false;
        });
    }, this.options.deliveryIntervalMs);
    this.deliveryTimer.unref();
  }

  private async currentOffset(): Promise<bigint> {
    const state = await this.prisma.notificationMatcherState.findUnique({
      where: { id: STATE_ID },
      select: { telegramUpdateOffset: true },
    });
    const stored = state?.telegramUpdateOffset ?? 0n;
    return stored > this.offset ? stored : this.offset;
  }

  /**
   * Never creates the row: the matcher owns its creation, and a row made here
   * would hand it an `eventsCursor`. Until it exists the offset lives in memory.
   */
  private async storeOffset(offset: bigint): Promise<void> {
    if (offset > this.offset) this.offset = offset;
    await this.prisma.notificationMatcherState.updateMany({
      where: { id: STATE_ID, telegramUpdateOffset: { lt: offset } },
      data: { telegramUpdateOffset: offset },
    });
  }
}
