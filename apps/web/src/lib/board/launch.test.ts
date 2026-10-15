import { describe, expect, test } from 'bun:test';
import type { ProjectRuntimeProfile } from '@agentdock/shared';
import {
  cardFormModelOptions,
  type LaunchCard,
  launchBaseline,
  launchChanges,
  launchDefaults,
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
    work: { model: 'sonnet', reason: 'A clear change to one module.' },
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
    });
    expect(launchDefaults(launchCard(), 'design').model).toBe('opus');
  });

  test('the card’s override wins, and work and design keep their own', () => {
    const card = launchCard({ model: 'haiku', profileKey: 'work-max' });
    expect(launchDefaults(card, 'work')).toEqual({
      profileKey: 'work-max',
      model: 'haiku',
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
});

describe('cardFormModelOptions', () => {
  test('the first option is the default: recommended, else the project’s', () => {
    expect(cardFormModelOptions(launchCard())[0]).toEqual({
      value: '',
      label: 'Recommended — Sonnet 5.5',
    });
    expect(
      cardFormModelOptions(launchCard({ recommendation: NONE }))[0],
    ).toEqual({ value: '', label: 'Project default' });
  });

  test('keeps a stored free-text model selectable, so a save does not rewrite it', () => {
    const values = cardFormModelOptions(launchCard({ model: 'opus[1m]' })).map(
      (o) => o.value,
    );
    expect(values).toContain('opus[1m]');
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
