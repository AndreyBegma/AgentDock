import { describe, expect, test } from 'bun:test';
import {
  UI_PROFILE_STYLE_RULE_MAX,
  type UiProfileVersionView,
} from '@nautelle/shared';
import {
  designRefHref,
  designRefLabel,
  memoryTextError,
  memoryUpdateBody,
  PROFILE_SOURCE_LABEL,
} from './profile-memory';

const screen = {
  designId: 'd1',
  revisionId: 'r1',
  name: 'Login',
  summary: 'A centred card.',
  snippetsUsed: ['button'],
  approvedAt: '2026-10-21T10:00:00.000Z',
};
const rule = {
  text: 'Primary actions sit bottom-right.',
  commentIds: ['c1'],
  designId: 'd1',
};

const profile: UiProfileVersionView = {
  id: 'p2',
  projectId: 'proj',
  version: 2,
  source: 'memory',
  hasUi: true,
  summary: 'Summary',
  kit: ':root{}',
  snippets: [{ name: 'button', html: '<button>Go</button>' }],
  fingerprintGlobs: [],
  fingerprint: '',
  obligations: null,
  runId: 'run-2',
  author: null,
  createdAt: '2026-10-21T10:00:00.000Z',
  screens: [screen],
  styleRules: [rule],
  learnedFromRevisionId: 'r1',
  learnNotes: null,
  designs: { d1: { kind: 'card', number: 12, title: 'Login' } },
};

describe('profile memory (#752 A5)', () => {
  test('a memory version reads as learned', () => {
    expect(PROFILE_SOURCE_LABEL.memory).toBe('Learned from a design');
  });

  test('links each item to its design, whoever owns it', () => {
    expect(
      designRefHref('proj', { kind: 'card', number: 12, title: 'x' }),
    ).toBe('/projects/proj/board/cards/12/design');
    expect(
      designRefHref('proj', { kind: 'stack', number: 3, title: 'x' }),
    ).toBe('/projects/proj/board/stacks/3/design');
    expect(
      designRefHref('proj', {
        kind: 'task',
        planId: 'pl1',
        taskKey: 't1',
        title: 'Exporter',
      }),
    ).toBe('/projects/proj/planner/pl1/tasks/t1/design');
    expect(
      designRefLabel({
        kind: 'task',
        planId: 'p',
        taskKey: 't1',
        title: 'Exporter',
      }),
    ).toBe('Exporter · t1');
  });

  test('a delete sends the rest of the version unchanged', () => {
    expect(memoryUpdateBody(profile, { screens: [] })).toEqual({
      hasUi: true,
      summary: 'Summary',
      kit: ':root{}',
      snippets: profile.snippets,
      screens: [],
      styleRules: [rule],
    });
  });

  test('refuses an empty or oversized edit', () => {
    expect(memoryTextError('rule', '  ')).toBe('Write the rule, or delete it.');
    expect(
      memoryTextError('rule', 'x'.repeat(UI_PROFILE_STYLE_RULE_MAX + 1)),
    ).toContain('At most');
    expect(memoryTextError('screen', 'Fine.')).toBeNull();
  });
});
