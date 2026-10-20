import { describe, expect, test } from 'bun:test';
import {
  STEWARD_DEFAULTS,
  type StewardActionRecord,
  type StewardDigestView,
} from '@nautelle/shared';
import { ApiError } from '../api';
import {
  actionLine,
  describeIssueLinkError,
  describeStewardError,
  digestCounts,
  digestIsQuiet,
  formOf,
  parseIssueInput,
  sameForm,
  settingsOf,
} from './format';

const at = '2026-10-16T12:00:00.000Z';
const record = (
  action: StewardActionRecord['action'],
  result: StewardActionRecord['result'] = 'ok',
  detail?: string,
): StewardActionRecord => ({
  action,
  at,
  result,
  ...(detail ? { detail } : {}),
});

describe('parseIssueInput (D8)', () => {
  test('empty unlinks, a number or #number links', () => {
    expect(parseIssueInput('')).toEqual({ ok: true, number: null });
    expect(parseIssueInput('  ')).toEqual({ ok: true, number: null });
    expect(parseIssueInput('447')).toEqual({ ok: true, number: 447 });
    expect(parseIssueInput(' #12 ')).toEqual({ ok: true, number: 12 });
  });

  test('anything else is refused before the call', () => {
    for (const bad of ['abc', '0', '-3', '1.5', '#', '12abc', '9999999999']) {
      expect(parseIssueInput(bad).ok).toBe(false);
    }
  });
});

describe('error text', () => {
  test('an invalid link shows the API message as it is', () => {
    const err = new ApiError(422, undefined, 'Issue #9 is closed');
    expect(describeIssueLinkError(err)).toBe('Issue #9 is closed');
  });

  test('settings: forbidden and missing are named', () => {
    expect(describeStewardError(new ApiError(403, undefined, 'x'))).toContain(
      'administrators',
    );
    expect(describeStewardError(new ApiError(404, undefined, 'x'))).toContain(
      'not found',
    );
  });
});

describe('actionLine (D9, D10)', () => {
  test('counts per action against its limit', () => {
    const history = [record('nudge'), record('resume'), record('nudge')];
    expect(actionLine(history[0] as StewardActionRecord, history)).toBe(
      'Nudged 1/2',
    );
    expect(actionLine(history[1] as StewardActionRecord, history)).toBe(
      'Resumed 1/2',
    );
    expect(actionLine(history[2] as StewardActionRecord, history)).toBe(
      'Nudged 2/2',
    );
  });

  test('a failure and a detail are said', () => {
    const history = [
      record('resume', 'failed'),
      record('hold_push', 'ok', '2 commits to rewrite'),
      record('dismiss'),
    ];
    expect(actionLine(history[0] as StewardActionRecord, history)).toBe(
      'Resumed 1/2 — failed',
    );
    expect(actionLine(history[1] as StewardActionRecord, history)).toBe(
      'Held the push — 2 commits to rewrite',
    );
    expect(actionLine(history[2] as StewardActionRecord, history)).toBe(
      'Dismissed a dialog',
    );
  });
});

describe('the settings form (D16)', () => {
  test('the defaults round-trip', () => {
    const result = settingsOf(formOf(STEWARD_DEFAULTS));
    expect(result).toEqual({ ok: true, settings: STEWARD_DEFAULTS });
  });

  test('a threshold out of range or not whole is refused', () => {
    for (const bad of ['0', '241', '1.5', 'ten', '']) {
      const form = { ...formOf(STEWARD_DEFAULTS), silenceMinutes: bad };
      expect(settingsOf(form).ok).toBe(false);
    }
    const edge = { ...formOf(STEWARD_DEFAULTS), silenceMinutes: '240' };
    expect(settingsOf(edge).ok).toBe(true);
  });

  test('a bad digest time is refused', () => {
    expect(
      settingsOf({ ...formOf(STEWARD_DEFAULTS), digestTime: '24:00' }).ok,
    ).toBe(false);
    expect(settingsOf({ ...formOf(STEWARD_DEFAULTS), digestTime: '' }).ok).toBe(
      false,
    );
  });

  test('sameForm ignores padding in the threshold only', () => {
    const base = formOf(STEWARD_DEFAULTS);
    expect(sameForm(base, { ...base, silenceMinutes: ' 10 ' })).toBe(true);
    expect(sameForm(base, { ...base, autoNudge: false })).toBe(false);
  });
});

describe('digest helpers', () => {
  const item = { label: 'C-1', title: 't', reason: null, url: null };
  const digest: StewardDigestView = {
    id: 'd',
    projectId: 'p',
    trigger: 'daily',
    createdAt: at,
    from: at,
    to: at,
    prose: null,
    done: [item, item],
    stuck: [item],
    waiting: [],
    spendUsd: '1.20',
  };

  test('counts every bucket', () => {
    expect(digestCounts(digest)).toBe('2 done · 1 stuck · 0 waiting on you');
  });

  test('quiet means all three empty', () => {
    expect(digestIsQuiet(digest)).toBe(false);
    expect(digestIsQuiet({ ...digest, done: [], stuck: [] })).toBe(true);
  });
});
