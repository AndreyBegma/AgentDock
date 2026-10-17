import { describe, expect, test } from 'bun:test';
import { isDefaultSet, skillsDiff, skillsPatch, skillsSource } from './skills';

const DEFAULTS = ['web-design-guidelines', 'frontend-design'];

describe('design skills form (#604)', () => {
  test('the tag says where the set comes from', () => {
    expect(skillsSource({ skills: DEFAULTS, edited: false }, DEFAULTS)).toBe(
      'default',
    );
    expect(skillsSource({ skills: ['x'], edited: true }, DEFAULTS)).toBe(
      'edited',
    );
    expect(skillsSource({ skills: [], edited: false }, [])).toBe('none');
  });

  test('a design that follows the default patches no skills, so it keeps following', () => {
    const design = { skills: DEFAULTS, skillsEdited: false };
    expect(skillsPatch({ skills: DEFAULTS, edited: false }, design)).toEqual(
      {},
    );
  });

  test('an edit here is sent as a hand edit; an unchanged stored edit is not resent', () => {
    expect(
      skillsPatch(
        { skills: ['x'], edited: true },
        { skills: DEFAULTS, skillsEdited: false },
      ),
    ).toEqual({ skills: ['x'] });
    expect(
      skillsPatch(
        { skills: ['x'], edited: true },
        { skills: ['x'], skillsEdited: true },
      ),
    ).toEqual({});
  });

  test('Use defaults on a stored edit returns the design to the default', () => {
    expect(
      skillsPatch(
        { skills: DEFAULTS, edited: false },
        { skills: ['x'], skillsEdited: true },
      ),
    ).toEqual({ useDefaultSkills: true });
  });

  test('the diff against the default and whether the set is saved already', () => {
    expect(skillsDiff(['frontend-design', 'ui-ux'], DEFAULTS)).toEqual({
      added: ['ui-ux'],
      removed: ['web-design-guidelines'],
    });
    expect(isDefaultSet([...DEFAULTS].reverse(), DEFAULTS)).toBe(true);
    expect(isDefaultSet(['frontend-design'], DEFAULTS)).toBe(false);
  });
});
