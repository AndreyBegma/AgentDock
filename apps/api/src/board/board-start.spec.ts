import {
  chooseCardStart,
  type StartDependency,
  unmergedDependencies,
} from './board-start';

const dependency = (
  number: number,
  over: Partial<StartDependency> = {},
): StartDependency => ({
  number,
  branch: `feat/c${number}-work`,
  prNumber: 100 + number,
  prState: 'open',
  mergedAt: null,
  ...over,
});

describe('chooseCardStart (#640)', () => {
  it('starts from the project base without an unmerged dependency', () => {
    expect(chooseCardStart([], 'develop', true)).toEqual({
      base: 'develop',
      card: null,
      missing: [],
    });
    const merged = [
      dependency(3, { prState: 'merged', mergedAt: new Date() }),
      dependency(4, { prState: 'merged' }),
    ];
    expect(chooseCardStart(merged, 'develop', true)).toEqual({
      base: 'develop',
      card: null,
      missing: [],
    });
  });

  it("starts from the one unmerged dependency's branch", () => {
    const deps = [
      dependency(3, { prState: 'merged', mergedAt: new Date() }),
      dependency(13, { prState: 'draft' }),
    ];
    expect(chooseCardStart(deps, 'develop', true)).toEqual({
      base: 'feat/c13-work',
      card: 13,
      missing: [],
    });
  });

  it('starts from the project base with several, and names them all', () => {
    const deps = [dependency(9), dependency(5, { prState: null })];
    expect(chooseCardStart(deps, 'develop', true)).toEqual({
      base: 'develop',
      card: null,
      missing: [
        { number: 5, branch: 'feat/c5-work' },
        { number: 9, branch: 'feat/c9-work' },
      ],
    });
  });

  it('names the one dependency missing when the runner cannot start from it', () => {
    expect(chooseCardStart([dependency(13)], 'develop', false)).toEqual({
      base: 'develop',
      card: null,
      missing: [{ number: 13, branch: 'feat/c13-work' }],
    });
  });
});

describe('unmergedDependencies (#640)', () => {
  it('leaves out a card without a branch or a PR, a closed PR and the base', () => {
    const deps = [
      dependency(1, { branch: null }),
      dependency(2, { prNumber: null }),
      dependency(3, { prState: 'closed' }),
      dependency(4, { branch: 'develop' }),
      dependency(5, { mergedAt: new Date() }),
      dependency(6),
    ];
    expect(unmergedDependencies(deps, 'develop')).toEqual([
      { number: 6, branch: 'feat/c6-work' },
    ]);
  });
});
