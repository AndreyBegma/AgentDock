import { describe, expect, test } from 'bun:test';
import type { AuditRecordView } from '@agentdock/shared';
import { actorLabel } from './format';

const record = (overrides: Partial<AuditRecordView>): AuditRecordView => ({
  seq: '1',
  ts: '2026-10-12T00:00:00.000Z',
  actorType: 'system',
  actorUserId: null,
  actorEmail: null,
  actorRunnerId: null,
  actorOnBehalfOfId: null,
  actorOnBehalfOfEmail: null,
  action: 'skill.run_started',
  targetType: 'run',
  targetId: 'r_1',
  projectId: 'p_1',
  before: null,
  after: null,
  result: 'ok',
  meta: null,
  prevHash: '0'.repeat(64),
  hash: 'f'.repeat(64),
  ...overrides,
});

describe('actorLabel', () => {
  test('a plain system actor', () => {
    expect(actorLabel(record({}))).toBe('system');
  });

  test('the system on behalf of a user: email, else a deleted user', () => {
    expect(
      actorLabel(
        record({
          actorOnBehalfOfId: 'u_1',
          actorOnBehalfOfEmail: 'ops@example.com',
        }),
      ),
    ).toBe('system on behalf of ops@example.com');
    expect(actorLabel(record({ actorOnBehalfOfId: 'u_1' }))).toBe(
      'system on behalf of a deleted user',
    );
  });

  test('a user by email, a runner by name and never by id', () => {
    expect(
      actorLabel(
        record({
          actorType: 'user',
          actorUserId: 'u_2',
          actorEmail: 'a@example.com',
        }),
      ),
    ).toBe('a@example.com');
    expect(
      actorLabel(record({ actorType: 'runner', actorRunnerId: 'rn_1' })),
    ).toBe('runner');
    expect(
      actorLabel(
        record({ actorType: 'runner', actorRunnerId: 'rn_1' }),
        new Map([['runner:rn_1', 'build-box']]),
      ),
    ).toBe('runner build-box');
  });
});
