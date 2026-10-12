import type { TerminalTarget } from '@agentdock/shared/protocol';
import { TerminalTickets } from './terminal-tickets';

const TTL = 30_000;
const target: TerminalTarget = {
  kind: 'slot',
  projectId: 'p1',
  root: '/srv/repo',
  slot: 'i42',
};
const grant = {
  userId: 'u1',
  sessionId: 's1',
  runnerId: 'r1',
  target,
  mode: 'read' as const,
};

describe('TerminalTickets', () => {
  const tickets = () =>
    new TerminalTickets({
      ticketTtlMs: TTL,
      idleTimeoutMs: 1,
      maxDurationMs: 1,
      revalidateMs: 1,
    });

  it('issues 32 random bytes, bound to the grant, expiring after the TTL', () => {
    const store = tickets();
    const issued = store.issue(grant, 1_000);
    expect(Buffer.from(issued.ticket, 'base64url')).toHaveLength(32);
    expect(issued.expiresAt.getTime()).toBe(1_000 + TTL);
    expect(store.consume(issued.ticket, 2_000)).toEqual({
      ...grant,
      ticketId: issued.ticketId,
    });
  });

  it('is single use', () => {
    const store = tickets();
    const { ticket } = store.issue(grant, 0);
    expect(store.consume(ticket, 1)).not.toBeNull();
    expect(store.consume(ticket, 2)).toBeNull();
  });

  it('refuses an expired ticket, and still uses it up', () => {
    const store = tickets();
    const { ticket } = store.issue(grant, 0);
    expect(store.consume(ticket, TTL)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('refuses an unknown ticket', () => {
    const store = tickets();
    store.issue(grant, 0);
    expect(store.consume('not-a-ticket', 1)).toBeNull();
  });

  it('issues distinct tickets and ticket ids', () => {
    const store = tickets();
    const a = store.issue(grant, 0);
    const b = store.issue(grant, 0);
    expect(a.ticket).not.toBe(b.ticket);
    expect(a.ticketId).not.toBe(b.ticketId);
  });

  it('forgets expired tickets when it issues the next', () => {
    const store = tickets();
    store.issue(grant, 0);
    store.issue(grant, TTL + 1);
    expect(store.size).toBe(1);
  });
});
