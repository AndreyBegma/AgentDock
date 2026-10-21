import { describe, expect, it } from 'bun:test';
import { cardTokenSaverSchema } from '../protocol/commands/cards';
import {
  armForMode,
  assignArm,
  TECHNIQUE_KEY_PATTERN,
  TOKEN_ECONOMY_TECHNIQUES,
  techniqueFlagsSchemaOf,
} from './techniques';

const cardIds = Array.from(
  { length: 1_000 },
  (_, i) => `cm${(i * 7_919).toString(36).padStart(8, '0')}card${i}`,
);

describe('assignArm (#746 D10)', () => {
  it('is always a at a B share of 0 and always b at 100', () => {
    for (const id of cardIds) {
      expect(assignArm(id, 'fixture', 0)).toBe('a');
      expect(assignArm(id, 'fixture', 100)).toBe('b');
    }
  });

  it('splits 1,000 cards within 45–55 % at a share of 50', () => {
    const b = cardIds.filter((id) => assignArm(id, 'fixture', 50) === 'b');
    expect(b.length).toBeGreaterThanOrEqual(450);
    expect(b.length).toBeLessThanOrEqual(550);
  });

  it('is reproducible, and independent per technique', () => {
    const one = cardIds.map((id) => assignArm(id, 'fixture', 50));
    expect(cardIds.map((id) => assignArm(id, 'fixture', 50))).toEqual(one);
    const other = cardIds.map((id) => assignArm(id, 'other-fixture', 50));
    const same = one.filter((arm, i) => arm === other[i]).length;
    expect(same).toBeGreaterThan(400);
    expect(same).toBeLessThan(600);
  });

  it('follows the mode: on → b, off → a, ab → the draw', () => {
    expect(armForMode('on', 'c1', 'fixture', 0)).toBe('b');
    expect(armForMode('off', 'c1', 'fixture', 100)).toBe('a');
    expect(armForMode('ab', 'c1', 'fixture', 100)).toBe('b');
    expect(armForMode('ab', 'c1', 'fixture', 0)).toBe('a');
  });
});

describe('the registry (#746)', () => {
  it('has unique, well-formed keys', () => {
    const keys = TOKEN_ECONOMY_TECHNIQUES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(TECHNIQUE_KEY_PATTERN);
  });
});

describe('technique flags (#746 D11)', () => {
  const schema = techniqueFlagsSchemaOf(['fixture']);

  it('takes booleans of known techniques', () => {
    expect(schema.parse({ fixture: true })).toEqual({ fixture: true });
    expect(schema.parse({})).toEqual({});
  });

  it('refuses an unknown key and a non-boolean', () => {
    expect(schema.safeParse({ unknown: true }).success).toBe(false);
    expect(schema.safeParse({ fixture: 'yes' }).success).toBe(false);
  });

  it('rides on card.run tokenSaver, strictly', () => {
    const base = { enabled: true, mcpAllow: [] };
    expect(cardTokenSaverSchema.safeParse(base).success).toBe(true);
    expect(
      cardTokenSaverSchema.safeParse({ ...base, techniques: {} }).success,
    ).toBe(true);
    // The production registry is empty: any key is unknown.
    expect(
      cardTokenSaverSchema.safeParse({ ...base, techniques: { nope: true } })
        .success,
    ).toBe(false);
  });
});
