import { describe, expect, test } from 'bun:test';
import type {
  PlanTaskVersionsView,
  PlanTaskVersionView,
} from '@nautelle/shared';
import { shownVersion, versionTurnText } from './versions';

const version = (n: number): PlanTaskVersionView => ({
  version: n,
  status: 'approved',
  frozen: n > 1,
  title: `Task v${n}`,
  summary: '',
  document: `doc ${n}`,
  rewriteComment: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  turn: null,
});

const view = (...ns: number[]): PlanTaskVersionsView => ({
  key: 't1',
  currentVersion: 3,
  versions: ns.map(version),
});

describe('shownVersion', () => {
  test('shows the picked version', () => {
    expect(shownVersion(view(1, 2, 3), 2)?.version).toBe(2);
  });

  test('falls back to the newest version when nothing or a vanished one is picked', () => {
    expect(shownVersion(view(1, 2, 3), null)?.version).toBe(3);
    expect(shownVersion(view(1), 3)?.version).toBe(1);
  });

  test('is undefined for an empty list', () => {
    expect(shownVersion(view(), null)).toBeUndefined();
  });
});

describe('versionTurnText', () => {
  test('names the action and its author', () => {
    expect(
      versionTurnText({
        id: 'x',
        action: 'revise',
        author: { id: 'u', name: 'Ada' },
        finishedAt: null,
      }),
    ).toBe('Revise the plan · Ada');
  });

  test('says so when the producing turn is unknown', () => {
    expect(versionTurnText(null)).toBe('Producing turn unknown');
  });
});
