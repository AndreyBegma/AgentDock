import { describe, expect, test } from 'bun:test';
import type { ProjectRuntimeProfile } from '@nautelle/shared';
import {
  type LaunchCard,
  launchBaseline,
  launchChanges,
  launchDefaults,
  launchEffortOptions,
  launchModelOptions,
  launchRequest,
  launchSavedNote,
  NO_RECOMMENDATION_TEXT,
  profileKeysWith,
  recommendationNote,
} from './launch';

const NONE = { work: null, design: null, assessedAt: null };

const launchCard = (extra: Partial<LaunchCard> = {}): LaunchCard => ({
  profileKey: null,
  model: null,
  designModel: null,
  recommendation: {
    work: {
      model: 'sonnet',
      effort: 'low',
      reason: 'A clear change to one module.',
    },
    design: { model: 'opus', reason: 'The layout is still open.' },
    assessedAt: '2026-10-15T10:00:00.000Z',
  },
  ...extra,
});

describe('launchDefaults (D2)', () => {
  test('a card without overrides starts on the recommendation for the action', () => {
    expect(launchDefaults(launchCard(), 'work')).toEqual({
      profileKey: '',
      model: 'sonnet',
      effort: 'low',
    });
    expect(launchDefaults(launchCard(), 'design').model).toBe('opus');
  });

  test('the card’s override wins, and work and design keep their own', () => {
    const card = launchCard({
      model: 'haiku',
      effort: 'high',
      profileKey: 'work-max',
    });
    expect(launchDefaults(card, 'work')).toEqual({
      profileKey: 'work-max',
      model: 'haiku',
      effort: 'high',
    });
    // The profile is shared; the design model is its own override.
    expect(launchDefaults(card, 'design')).toEqual({
      profileKey: 'work-max',
      model: 'opus',
    });
    expect(
      launchDefaults(launchCard({ designModel: 'sonnet' }), 'design').model,
    ).toBe('sonnet');
  });

  test('without a recommendation nothing is picked: the project’s model follows', () => {
    expect(
      launchDefaults(launchCard({ recommendation: NONE }), 'work').model,
    ).toBe('');
  });
});

describe('Use defaults (D3)', () => {
  test('the baseline is the resolver and the recommendation, never the override', () => {
    const card = launchCard({ designModel: 'haiku', profileKey: 'work-max' });
    expect(launchBaseline(card, 'design')).toEqual({
      profileKey: '',
      model: 'opus',
    });
    expect(
      launchBaseline(launchCard({ recommendation: NONE }), 'work'),
    ).toEqual({ profileKey: '', model: '' });
  });

  test('names what moved off it, and nothing when the card follows the defaults', () => {
    const card = launchCard();
    expect(
      launchChanges(launchDefaults(card, 'design'), card, 'design'),
    ).toEqual([]);
    expect(
      launchChanges(
        { profileKey: 'work-max', model: 'sonnet' },
        card,
        'design',
      ),
    ).toEqual(['profile', 'model']);
    expect(
      launchChanges({ profileKey: '', model: 'sonnet' }, card, 'design'),
    ).toEqual(['model']);
  });

  test('the saved note appears only for a non-default choice', () => {
    expect(launchSavedNote([], 'C-15')).toBeNull();
    expect(launchSavedNote(['profile', 'model'], 'C-15')).toBe(
      'Your profile and model choice is saved on C-15 and used by its next design turns, including auto-starts.',
    );
  });
});

describe('launchModelOptions', () => {
  test('marks the recommended option, "Sonnet 5.5 (recommended)"', () => {
    const options = launchModelOptions(launchCard(), 'work');
    expect(options.find((o) => o.value === 'sonnet')?.label).toBe(
      'Sonnet 5.5 (recommended)',
    );
    expect(options.some((o) => o.value === '')).toBe(false);
  });

  test('offers "Project default" first when there is nothing to follow (D7)', () => {
    const options = launchModelOptions(
      launchCard({ recommendation: NONE }),
      'work',
    );
    expect(options[0]).toMatchObject({ value: '', label: 'Project default' });
    expect(options.some((o) => o.recommended)).toBe(false);
  });

  test('a stored id outside the catalog is its own selected option (D4)', () => {
    const options = launchModelOptions(
      launchCard({ model: 'claude-opus-5-5' }),
      'work',
    );
    expect(options[0]).toMatchObject({
      value: 'claude-opus-5-5',
      label: 'claude-opus-5-5',
      inCatalog: false,
    });
  });
});

describe('launchEffortOptions (#663)', () => {
  test('marks the recommended effort, "Low (recommended)", with no default', () => {
    const options = launchEffortOptions(launchCard());
    expect(options.map((o) => o.label)).toEqual([
      'Low (recommended)',
      'Medium',
      'High',
    ]);
  });

  test('offers "Claude default" first when there is nothing to follow', () => {
    const options = launchEffortOptions(launchCard({ recommendation: NONE }));
    expect(options[0]).toEqual({
      value: '',
      label: 'Claude default',
      recommended: false,
    });
    expect(
      launchDefaults(launchCard({ recommendation: NONE }), 'work').effort,
    ).toBe('');
  });

  test('a card assessed before effort follows its override, else the default', () => {
    const before = launchCard({
      recommendation: {
        ...launchCard().recommendation,
        work: { model: 'opus', effort: null, reason: 'x' },
      },
    });
    expect(launchDefaults(before, 'work').effort).toBe('');
    expect(launchDefaults({ ...before, effort: 'medium' }, 'work').effort).toBe(
      'medium',
    );
  });
});

describe('recommendationNote', () => {
  test('names the model and the reason, or that there is none', () => {
    expect(recommendationNote(launchCard(), 'work')).toBe(
      'Sonnet 5.5: A clear change to one module.',
    );
    expect(
      recommendationNote(launchCard({ recommendation: NONE }), 'design'),
    ).toBe(NO_RECOMMENDATION_TEXT);
  });
});

describe('launchRequest', () => {
  test('sends what is set; the default sends nothing, so the API follows D2', () => {
    expect(launchRequest({ profileKey: '', model: '' })).toEqual({});
    expect(launchRequest({ profileKey: 'work-max', model: 'opus' })).toEqual({
      profileKey: 'work-max',
      model: 'opus',
    });
  });

  test('#663: sends a chosen effort; the default or a design form sends none', () => {
    expect(launchRequest({ profileKey: '', model: '', effort: 'low' })).toEqual(
      { effort: 'low' },
    );
    expect(launchRequest({ profileKey: '', model: '', effort: '' })).toEqual(
      {},
    );
    expect(launchDefaults(launchCard(), 'design').effort).toBeUndefined();
  });
});

describe('profileKeysWith', () => {
  const profiles = [{ key: 'a' }, { key: 'b' }] as ProjectRuntimeProfile[];

  test('keeps a key the runner no longer lists', () => {
    expect(profileKeysWith(profiles, 'gone')).toEqual(['gone', 'a', 'b']);
    expect(profileKeysWith(profiles, 'a')).toEqual(['a', 'b']);
    expect(profileKeysWith(profiles, '')).toEqual(['a', 'b']);
  });
});
