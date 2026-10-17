import { describe, expect, it } from 'bun:test';
import { heartbeatMessageSchema } from './messages';

const base = {
  type: 'heartbeat',
  ts: '2026-10-07T18:36:15.000Z',
  load: [0.42, 0.51, 0.6],
  tmuxSessions: 4,
  collectors: { tmux: { ok: true } },
};

describe('heartbeat profiles (#348 D4)', () => {
  it('accepts a heartbeat without profiles (an older runner)', () => {
    expect(heartbeatMessageSchema.safeParse(base).success).toBe(true);
  });

  it('accepts one agentdock state per profile id', () => {
    const parsed = heartbeatMessageSchema.safeParse({
      ...base,
      profiles: {
        work: { plugin: '0.9.0', telemetry: true },
        personal: { plugin: null, telemetry: false },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.profiles?.personal?.plugin).toBeNull();
  });

  it('rejects an empty profile id and a malformed state', () => {
    expect(
      heartbeatMessageSchema.safeParse({
        ...base,
        profiles: { '': { plugin: null, telemetry: false } },
      }).success,
    ).toBe(false);
    expect(
      heartbeatMessageSchema.safeParse({
        ...base,
        profiles: { work: { plugin: '', telemetry: false } },
      }).success,
    ).toBe(false);
  });
});
