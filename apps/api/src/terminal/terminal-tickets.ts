import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TerminalMode, TerminalTarget } from '@agentdock/shared/protocol';
import { Inject, Injectable } from '@nestjs/common';
import { TERMINAL_OPTIONS, type TerminalOptions } from './terminal-options';

/** What a ticket lets its holder open, bound when it is issued (D5). */
export interface TerminalGrant {
  /** Names the ticket in the audit log; the ticket itself is never stored or logged. */
  ticketId: string;
  userId: string;
  /** The session that asked; the upgrade must carry the same session cookie. */
  sessionId: string;
  runnerId: string;
  target: TerminalTarget;
  mode: TerminalMode;
}

export interface IssuedTicket {
  ticket: string;
  ticketId: string;
  expiresAt: Date;
}

interface Stored {
  grant: TerminalGrant;
  expiresAt: number;
}

const hash = (ticket: string): string =>
  createHash('sha256').update(ticket).digest('hex');

/**
 * One-time attach tickets (D5): 32 random bytes, single use, valid for
 * `ticketTtlMs`. Kept in memory by hash only — a single API instance is
 * assumed, like `/live`; a restart voids every outstanding ticket.
 */
@Injectable()
export class TerminalTickets {
  private readonly tickets = new Map<string, Stored>();

  constructor(
    @Inject(TERMINAL_OPTIONS) private readonly options: TerminalOptions,
  ) {}

  issue(
    grant: Omit<TerminalGrant, 'ticketId'>,
    now = Date.now(),
  ): IssuedTicket {
    this.sweep(now);
    const ticket = randomBytes(32).toString('base64url');
    const ticketId = randomUUID();
    const expiresAt = now + this.options.ticketTtlMs;
    this.tickets.set(hash(ticket), {
      grant: { ...grant, ticketId },
      expiresAt,
    });
    return { ticket, ticketId, expiresAt: new Date(expiresAt) };
  }

  /** The grant of `ticket`, used up by this call; null when unknown, used or expired. */
  consume(ticket: string, now = Date.now()): TerminalGrant | null {
    const key = hash(ticket);
    const stored = this.tickets.get(key);
    if (!stored) return null;
    this.tickets.delete(key);
    return stored.expiresAt > now ? stored.grant : null;
  }

  /** Tickets issued and neither used nor expired (tests). */
  get size(): number {
    return this.tickets.size;
  }

  private sweep(now: number): void {
    for (const [key, stored] of this.tickets) {
      if (stored.expiresAt <= now) this.tickets.delete(key);
    }
  }
}
