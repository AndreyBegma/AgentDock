import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { RunnerPeer } from './runner-connections';

/** A runner's live socket taken over by another connection with its token. */
export interface RunnerReplacement {
  runnerId: string;
  /** The socket that was live and was closed 4409. */
  previous: RunnerPeer & { connectedAt: Date };
  /** The connection that took its place. */
  next: RunnerPeer;
  at: Date;
}

/** Told about every replacement after it is audited — the admin notification. */
export interface RunnerReplacementListener {
  /** A short name for logs, e.g. 'notifications'. */
  readonly name: string;
  replaced(replacement: RunnerReplacement): Promise<void>;
}

/**
 * C-108: a second connection with a runner's token silently kicked the real
 * daemon off. Whoever holds the token can do that — an agent session on the
 * machine can read it — so every takeover of a live socket is recorded as
 * `runner.connection_replaced` with both peers, and passed to the listeners
 * (notifications registers here: it imports `RunnersModule`, not the reverse).
 */
@Injectable()
export class RunnerReplacements {
  private readonly logger = new Logger(RunnerReplacements.name);
  private readonly listeners: RunnerReplacementListener[] = [];

  constructor(private readonly audit: AuditService) {}

  register(listener: RunnerReplacementListener): void {
    this.listeners.push(listener);
  }

  /** Audits, then runs every listener; a failing one never stops the rest. */
  async replaced(replacement: RunnerReplacement): Promise<void> {
    const { runnerId, previous, next } = replacement;
    this.logger.warn(
      `runner ${runnerId}: live connection from ${previous.ip ?? '?'} replaced by one from ${next.ip ?? '?'}`,
    );
    await this.audit.record({
      actor: { type: 'runner', runnerId },
      origin: {
        ip: next.ip ?? undefined,
        userAgent: next.userAgent ?? undefined,
      },
      action: 'runner.connection_replaced',
      target: { type: 'runner', id: runnerId },
      result: 'ok',
      meta: {
        previousIp: previous.ip,
        previousUserAgent: previous.userAgent?.slice(0, 512) ?? null,
        previousConnectedAt: previous.connectedAt,
      },
    });
    for (const listener of this.listeners) {
      try {
        await listener.replaced(replacement);
      } catch (error) {
        this.logger.error(
          `replacement listener ${listener.name} failed for runner ${runnerId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}
