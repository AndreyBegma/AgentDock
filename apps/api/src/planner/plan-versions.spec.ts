import { type VersionTurn, versionTurns } from './plan-versions';

const author = { id: 'u1', name: 'Ada' };
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const turn = (
  id: string,
  action: VersionTurn['action'],
  finished: number | null,
  created = finished ?? 0,
): VersionTurn => ({
  id,
  action,
  author,
  finishedAt: finished === null ? null : at(finished),
  createdAt: at(created),
});

const ids = (map: ReturnType<typeof versionTurns>) =>
  [...map.entries()].sort(([a], [b]) => a - b).map(([v, t]) => [v, t.id]);

describe('versionTurns', () => {
  it('gives version 1 to the decompose and each later one to the next revise, by finish time', () => {
    const map = versionTurns([
      turn('r2', 'revise', 30),
      turn('d', 'decompose', 5),
      turn('r1', 'revise', 20),
    ]);
    expect(ids(map)).toEqual([
      [1, 'd'],
      [2, 'r1'],
      [3, 'r2'],
    ]);
    expect(map.get(2)).toEqual({
      id: 'r1',
      action: 'revise',
      author,
      finishedAt: at(20).toISOString(),
    });
  });

  it('breaks a finish-time tie by creation order', () => {
    const map = versionTurns([
      turn('late', 'revise', 10, 9),
      turn('early', 'revise', 10, 2),
    ]);
    expect(ids(map)).toEqual([
      [2, 'early'],
      [3, 'late'],
    ]);
  });

  it('leaves version 1 out when no decompose succeeded', () => {
    expect(ids(versionTurns([turn('r1', 'revise', 3)]))).toEqual([[2, 'r1']]);
    expect(versionTurns([]).size).toBe(0);
  });
});
