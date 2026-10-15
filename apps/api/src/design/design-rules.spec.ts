import {
  batchOf,
  designBlocks,
  designTurnPlanOf,
  nextOfBatch,
  suggestionOf,
  suggestionUpdate,
  withDesign,
} from './design-rules';

describe('designBlocks / withDesign (D1)', () => {
  it('holds a ready task while its design is on and not approved', () => {
    const on = { needed: true, status: 'reviewing' as const };
    expect(designBlocks(on)).toBe(true);
    expect(withDesign('ready', on)).toBe('needs_design');
    expect(withDesign('needs_talk', on)).toBe('needs_talk');
  });

  it('releases it once the design is approved or switched off', () => {
    expect(
      withDesign('needs_design', { needed: true, status: 'approved' }),
    ).toBe('ready');
    expect(withDesign('needs_design', { needed: false, status: 'idle' })).toBe(
      'ready',
    );
    expect(withDesign('needs_design', null)).toBe('ready');
    expect(withDesign('approved', { needed: true, status: 'idle' })).toBe(
      'approved',
    );
  });
});

describe('suggestions (D2, D3)', () => {
  const suggestion = {
    needed: true,
    why: 'A new screen.',
    variants: 2 as const,
  };

  it('turns every suggestion off in a project whose profile has no UI', () => {
    expect(suggestionOf(suggestion, false)).toMatchObject({
      needed: false,
      suggested: false,
    });
    expect(suggestionOf(suggestion, null)).toMatchObject({
      needed: true,
      suggested: true,
      variantCount: 2,
    });
  });

  it('never changes the person’s switch, and the count only before anything is drawn', () => {
    const s = suggestionOf(suggestion, true);
    expect(suggestionUpdate(s, { status: 'idle', drawn: false })).toEqual({
      suggested: true,
      suggestionWhy: 'A new screen.',
      variantCount: 2,
    });
    expect(suggestionUpdate(s, { status: 'reviewing', drawn: true })).toEqual({
      suggested: true,
      suggestionWhy: 'A new screen.',
    });
  });
});

describe('batchOf (D4, D10)', () => {
  it('generates the variants up to the count that have no revision', () => {
    expect(batchOf('generate', 3, [], [], 'p1')).toEqual({
      mode: 'generate',
      variant: 1,
      remaining: [2, 3],
      comments: [],
      profileId: 'p1',
    });
    const drawn = [{ variant: 1, archived: false }];
    expect(batchOf('generate', 2, drawn, ['c1'], null)).toMatchObject({
      variant: 2,
      remaining: [],
      comments: [],
    });
    expect(batchOf('generate', 1, drawn, [], null)).toBeNull();
  });

  it('revises every variant in play with the open comments', () => {
    const revisions = [
      { variant: 2, archived: false },
      { variant: 1, archived: false },
      { variant: 1, archived: false },
      { variant: 3, archived: true },
    ];
    const batch = batchOf('revise', 3, revisions, ['c1', 'c2'], 'p1');
    expect(batch).toMatchObject({
      variant: 1,
      remaining: [2],
      comments: ['c1', 'c2'],
    });
    expect(batch && nextOfBatch(batch)).toMatchObject({
      variant: 2,
      remaining: [],
      comments: ['c1', 'c2'],
    });
  });

  it('reads a turn plan back from run args, and nothing from others', () => {
    const plan = batchOf('generate', 2, [], [], null);
    expect(designTurnPlanOf({ planId: 'x', design: plan })).toEqual(plan);
    expect(designTurnPlanOf({ planId: 'x' })).toBeNull();
    expect(designTurnPlanOf(null)).toBeNull();
  });
});
