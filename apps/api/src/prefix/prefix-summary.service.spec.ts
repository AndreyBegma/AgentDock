import { kindsOf, median } from './prefix-summary.service';

const run = (
  launchKind: string,
  estTokens: number,
  prefixTokens: number | null,
) => ({
  runId: `${launchKind}-${estTokens}`,
  launchKind,
  estTokens,
  prefixTokens,
});

describe('the Prefix section (#751 B2, B3)', () => {
  it('takes the median of odd and even counts', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(3);
  });

  it('flags a kind by its measured median, else by the parts', () => {
    const kinds = kindsOf(
      [
        run('card', 10_000, 30_000),
        run('card', 11_000, 28_000),
        run('card', 12_000, null),
        run('plan', 9_000, null),
      ],
      25_000,
    );
    expect(kinds).toEqual([
      {
        launchKind: 'card',
        launches: 3,
        medianTokens: 29_000,
        medianEstTokens: 11_000,
        overBudget: true,
      },
      {
        launchKind: 'plan',
        launches: 1,
        medianTokens: null,
        medianEstTokens: 9_000,
        overBudget: false,
      },
    ]);
  });

  it('a changed budget changes the flag', () => {
    const runs = [run('card', 10_000, 20_000)];
    expect(kindsOf(runs, 25_000)[0]?.overBudget).toBe(false);
    expect(kindsOf(runs, 15_000)[0]?.overBudget).toBe(true);
  });
});
