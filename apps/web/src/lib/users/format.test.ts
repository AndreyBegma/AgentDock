import { describe, expect, test } from 'bun:test';
import { ROLES } from '@nautelle/shared';
import {
  defaultUsersTab,
  deleteUserCopy,
  ROLE_HINT,
  roleChangeCopy,
  roleChangeNeedsConfirm,
} from './format';

describe('roleChangeNeedsConfirm', () => {
  test('to or from admin asks first', () => {
    expect(roleChangeNeedsConfirm('operator', 'admin')).toBe(true);
    expect(roleChangeNeedsConfirm('admin', 'viewer')).toBe(true);
  });

  test('between operator and viewer, or no change, goes straight through', () => {
    expect(roleChangeNeedsConfirm('operator', 'viewer')).toBe(false);
    expect(roleChangeNeedsConfirm('viewer', 'operator')).toBe(false);
    expect(roleChangeNeedsConfirm('admin', 'admin')).toBe(false);
  });

  test('the confirmation names what opens or closes', () => {
    expect(roleChangeCopy({ email: 'a@x' }, 'admin').text).toContain(
      'every project',
    );
    expect(roleChangeCopy({ email: 'a@x' }, 'viewer').verb).toBe('Make viewer');
  });
});

test('every role has a hint', () => {
  for (const role of ROLES) expect(ROLE_HINT[role].length).toBeGreaterThan(10);
});

test('delete copy says what goes and what stays', () => {
  const text = deleteUserCopy({ email: 'a@x' });
  expect(text).toContain('schedules they created');
  expect(text).toContain('stays');
});

describe('defaultUsersTab', () => {
  const counts = { pending: 0, active: 0, disabled: 0, rejected: 0 };

  test('opens on Active when it has accounts', () => {
    expect(defaultUsersTab({ ...counts, active: 3, pending: 2 })).toBe(
      'active',
    );
  });

  test('falls to the first tab with rows', () => {
    expect(defaultUsersTab({ ...counts, pending: 1 })).toBe('pending');
    expect(defaultUsersTab({ ...counts, rejected: 4, disabled: 1 })).toBe(
      'disabled',
    );
  });

  test('is Active when nothing exists', () => {
    expect(defaultUsersTab(counts)).toBe('active');
  });
});
