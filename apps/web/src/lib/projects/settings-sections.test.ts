import { describe, expect, test } from 'bun:test';
import {
  SETTINGS_ITEM_SECTION,
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTIONS,
  settingsItemOf,
} from './settings-sections';

/** The thirteen tabs the settings page had before #704. */
const FORMER_TABS = [
  'general',
  'docs',
  'rules',
  'orchestrator',
  'members',
  'budget',
  'planner',
  'design',
  'board',
  'token-saver',
  'steward',
  'ai-digest',
  'sessions',
];

describe('project settings sections (#704)', () => {
  test('four sections hold every former tab exactly once', () => {
    expect(SETTINGS_SECTION_IDS).toEqual([
      'project',
      'automation',
      'planning',
      'cost',
    ]);
    const items: string[] = SETTINGS_SECTIONS.flatMap(({ items }) =>
      items.map(({ id }) => id),
    );
    // Review (#890) and Demo videos (C-371) were never tabs.
    expect([...items].sort()).toEqual(
      [...FORMER_TABS, 'review', 'demo-videos'].sort(),
    );
  });

  test('an old tab link maps to the section that holds it', () => {
    expect(SETTINGS_ITEM_SECTION.budget).toBe('cost');
    expect(SETTINGS_ITEM_SECTION['token-saver']).toBe('cost');
    expect(SETTINGS_ITEM_SECTION.sessions).toBe('automation');
    expect(SETTINGS_ITEM_SECTION.orchestrator).toBe('automation');
    expect(SETTINGS_ITEM_SECTION.design).toBe('planning');
    expect(SETTINGS_ITEM_SECTION.docs).toBe('project');
    expect(SETTINGS_ITEM_SECTION.general).toBe('project');
  });

  test('settingsItemOf knows only former tab ids', () => {
    expect(settingsItemOf('budget')).toBe('budget');
    expect(settingsItemOf('cost')).toBeUndefined();
    expect(settingsItemOf('toString')).toBeUndefined();
    expect(settingsItemOf(null)).toBeUndefined();
  });

  test('a section id never collides with a former tab id', () => {
    for (const id of SETTINGS_SECTION_IDS) {
      expect(FORMER_TABS).not.toContain(id);
    }
  });
});
