import { designSkillsOf, followsDefaultSkills } from './design-store';

const DEFAULTS = ['web-design-guidelines', 'frontend-design'];

describe('design skills resolution (#604)', () => {
  it('a design never edited and not generated follows the project default', () => {
    const design = {
      skills: ['old'],
      skillsEdited: false,
      status: 'idle' as const,
    };
    expect(followsDefaultSkills(design, false)).toBe(true);
    expect(designSkillsOf(design, false, DEFAULTS)).toEqual(DEFAULTS);
  });

  it('an empty default leaves a following design with no skills', () => {
    const design = {
      skills: ['old'],
      skillsEdited: false,
      status: 'idle' as const,
    };
    expect(designSkillsOf(design, false, [])).toEqual([]);
  });

  it('a hand-edited design keeps its own set', () => {
    const design = {
      skills: ['mine'],
      skillsEdited: true,
      status: 'idle' as const,
    };
    expect(followsDefaultSkills(design, false)).toBe(false);
    expect(designSkillsOf(design, false, DEFAULTS)).toEqual(['mine']);
  });

  it('a generated design keeps the set it was drawn with', () => {
    const design = {
      skills: ['copied'],
      skillsEdited: false,
      status: 'idle' as const,
    };
    expect(designSkillsOf(design, true, DEFAULTS)).toEqual(['copied']);
    for (const status of ['generating', 'reviewing', 'approved'] as const) {
      expect(designSkillsOf({ ...design, status }, false, DEFAULTS)).toEqual([
        'copied',
      ]);
    }
  });
});
