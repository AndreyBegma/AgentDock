import { describe, expect, it } from 'bun:test';
import { parseCommand } from '../commands';
import { demoStatusDataSchema, isDemoEventType } from '../events/demos';
import { cardDemoArgsSchema } from './demos';

const args = {
  cardId: 'card_1',
  projectId: 'p1',
  card: 412,
  round: 2,
  demoId: 'demo_1',
  worktree: { root: '/home/me/app', shortId: 'abcd1234' },
  scenario: 'demoflow/cards/C-412-add-usage-export.demo.json',
  env: ['DEMO_ADMIN_EMAIL', 'DEMO_ADMIN_PASSWORD'],
};

describe('card.demo (ADR-0090)', () => {
  it('is in the allowlist and takes the typed args', () => {
    const parsed = parseCommand('card.demo', args);
    expect(parsed.ok).toBe(true);
  });

  it('carries secret names only — a value field is refused', () => {
    expect(
      cardDemoArgsSchema.safeParse({
        ...args,
        env: [{ name: 'DEMO_ADMIN_PASSWORD', value: 'hunter2' }],
      }).success,
    ).toBe(false);
    expect(
      cardDemoArgsSchema.safeParse({ ...args, secrets: { A: 'b' } }).success,
    ).toBe(false);
  });

  it('refuses a worktree path, duplicate names and a stray scenario', () => {
    expect(
      cardDemoArgsSchema.safeParse({ ...args, worktree: '/tmp/x' }).success,
    ).toBe(false);
    expect(
      cardDemoArgsSchema.safeParse({ ...args, env: ['A', 'A'] }).success,
    ).toBe(false);
    expect(
      cardDemoArgsSchema.safeParse({ ...args, scenario: '../../etc/passwd' })
        .success,
    ).toBe(false);
  });
});

describe('demo.status (ADR-0090)', () => {
  const base = {
    cardId: 'card_1',
    projectId: 'p1',
    demoId: 'demo_1',
    at: '2026-10-24T10:00:00.000Z',
  };

  it('is a demo event type', () => {
    expect(isDemoEventType('demo.status')).toBe(true);
    expect(isDemoEventType('card_run.pushed')).toBe(false);
  });

  it('needs a reason for failed and skipped, not for recording', () => {
    expect(
      demoStatusDataSchema.safeParse({ ...base, status: 'recording' }).success,
    ).toBe(true);
    expect(
      demoStatusDataSchema.safeParse({ ...base, status: 'failed' }).success,
    ).toBe(false);
    expect(
      demoStatusDataSchema.safeParse({
        ...base,
        status: 'failed',
        reason: 'The app did not answer within 60 s.',
      }).success,
    ).toBe(true);
  });

  it('never reports ready — the upload makes a demo ready', () => {
    expect(
      demoStatusDataSchema.safeParse({ ...base, status: 'ready' }).success,
    ).toBe(false);
  });
});
