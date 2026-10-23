import { describe, expect, test } from 'bun:test';
import { NO_INTERVAL } from '@nautelle/shared';
import {
  dataLabel,
  enableConsequence,
  formatCostInterval,
  formatSignalInterval,
  parseBShare,
  stopConsequence,
} from './economy';
import { armFixture, techniqueFixture } from './economy.fixture';

describe('formatCostInterval (#746 D1)', () => {
  test('a cost and its interval', () => {
    expect(formatCostInterval({ point: 1.2, low: 0.9, high: 1.6 })).toEqual({
      point: '$1.20',
      range: '$0.90–$1.60',
    });
  });

  test('no merged card is a dash, never $0.00', () => {
    expect(formatCostInterval(NO_INTERVAL)).toEqual({
      point: '—',
      range: null,
    });
  });
});

describe('formatSignalInterval (#746 D3)', () => {
  test('a rate is a whole percent', () => {
    expect(
      formatSignalInterval('greenFirstPush', {
        point: 0.62,
        low: 0.481,
        high: 0.74,
      }),
    ).toEqual({ point: '62%', range: '48–74%' });
  });

  test('rounds are a mean with one decimal', () => {
    expect(
      formatSignalInterval('rounds', { point: 3.14, low: 2.6, high: 3.7 }),
    ).toEqual({ point: '3.1', range: '2.6–3.7' });
  });

  test('a point without an interval shows the point alone', () => {
    expect(
      formatSignalInterval('noRetries', { point: 1, low: null, high: null }),
    ).toEqual({ point: '100%', range: null });
  });
});

describe('dataLabel (#746 enough-data marker)', () => {
  test('enough data', () => {
    expect(dataLabel(techniqueFixture(), 30)).toBe('Enough data');
  });

  test('collecting says how far each arm is', () => {
    const t = techniqueFixture({
      enoughData: false,
      a: armFixture('a', { settledCards: 12 }),
      b: armFixture('b', { settledCards: 8 }),
    });
    expect(dataLabel(t, 30)).toBe('Collecting · A 12/30 · B 8/30');
  });
});

describe('enableConsequence (#746 D5)', () => {
  test('names the four signals', () => {
    const text = enableConsequence(techniqueFixture(), 30);
    expect(text).toContain('Every new card will run Read guard');
    expect(text).toContain('green on the first push');
    expect(text).toContain('rounds per card');
    expect(text).toContain('merged without review returns');
    expect(text).toContain('no retries');
    expect(text).not.toContain('worse');
  });

  test('says which signals arm B worsens, and when data is short', () => {
    const text = enableConsequence(
      techniqueFixture({
        worsens: ['rounds'],
        enoughData: false,
        b: armFixture('b', { settledCards: 8 }),
      }),
      30,
    );
    expect(text).toContain('Arm B is worse on rounds per card.');
    expect(text).toContain('40 settled cards in A and 8 in B, of 30 each');
  });

  test('Stop leaves arm B cards running it until they settle', () => {
    expect(stopConsequence(techniqueFixture())).toContain(
      'Cards already in arm B keep running it',
    );
  });
});

describe('parseBShare', () => {
  test('a whole number 0–100', () => {
    expect(parseBShare('0')).toBe(0);
    expect(parseBShare(' 50 ')).toBe(50);
    expect(parseBShare('100')).toBe(100);
  });

  test('anything else is refused', () => {
    expect(parseBShare('')).toBeNull();
    expect(parseBShare('101')).toBeNull();
    expect(parseBShare('-1')).toBeNull();
    expect(parseBShare('12.5')).toBeNull();
    expect(parseBShare('abc')).toBeNull();
  });
});
