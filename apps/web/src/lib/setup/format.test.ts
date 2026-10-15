import { describe, expect, test } from 'bun:test';
import type { TerminalSetupItem, TerminalSetupView } from '@agentdock/shared';
import {
  setupItemTitle,
  stepNeedsAdmin,
  stepsLabel,
  terminalSetupNeed,
  terminalSetupNeeds,
} from './format';

const view = (todo: number): TerminalSetupView => ({
  items: [],
  complete: todo === 0,
  todo,
  closing: '',
});

const project = (id: string, role: 'viewer' | 'operator' | 'admin') => ({
  id,
  displayName: `Project ${id}`,
  role,
});

describe('terminalSetupNeed', () => {
  test('names the project and the number of steps, and links the checklist', () => {
    expect(terminalSetupNeed(project('p1', 'operator'), view(3))).toEqual({
      key: 'terminal-setup:p1',
      projectId: 'p1',
      projectName: 'Project p1',
      title: 'Terminal sessions don’t reach the Board',
      reason: '3 steps',
      href: '/projects/p1/settings?tab=sessions',
    });
  });

  test('is none when nothing required is to do', () => {
    expect(terminalSetupNeed(project('p1', 'admin'), view(0))).toBeNull();
  });

  test('is none for a viewer, and while the view is not loaded', () => {
    expect(terminalSetupNeed(project('p1', 'viewer'), view(2))).toBeNull();
    expect(terminalSetupNeed(project('p1', 'admin'), undefined)).toBeNull();
  });

  test('lists only the projects that need it', () => {
    const views = new Map([
      ['a', view(1)],
      ['b', view(0)],
    ]);
    const needs = terminalSetupNeeds(
      [project('a', 'admin'), project('b', 'admin'), project('c', 'admin')],
      views,
    );
    expect(needs.map((need) => need.projectId)).toEqual(['a']);
    expect(needs[0]?.reason).toBe('1 step');
  });
});

describe('checklist copy', () => {
  test('a per-profile item carries its profile key', () => {
    const item: TerminalSetupItem = {
      id: 'plugin',
      state: 'todo',
      optional: false,
      profileKey: 'claude-main',
      steps: [],
    };
    expect(setupItemTitle(item)).toBe(
      'agentdock plugin is installed · claude-main',
    );
    expect(
      setupItemTitle({ ...item, id: 'content', profileKey: undefined }),
    ).toBe('Session content is on');
  });

  test('only a link into project settings needs an admin', () => {
    expect(
      stepNeedsAdmin({
        kind: 'link',
        href: '/projects/p1/settings?tab=board',
        label: 'x',
      }),
    ).toBe(true);
    expect(stepNeedsAdmin({ kind: 'link', href: '/install', label: 'x' })).toBe(
      false,
    );
    expect(stepNeedsAdmin({ kind: 'command', code: 'ls' })).toBe(false);
    expect(stepNeedsAdmin({ kind: 'note', text: 'x' })).toBe(false);
  });

  test('pluralises steps', () => {
    expect(stepsLabel(1)).toBe('1 step');
    expect(stepsLabel(2)).toBe('2 steps');
  });
});
