import { describe, expect, test } from 'bun:test';
import type { ModelPriceInput } from '@agentdock/shared';
import {
  compilePattern,
  costOrBlank,
  customRange,
  formatUsd,
  formFromModel,
  groupLabel,
  intervalFor,
  modelFromForm,
  perMillion,
  perToken,
  presetRange,
  rangeQuery,
} from './format';

describe('ranges', () => {
  test('a preset ends at the next full hour and spans exactly its length', () => {
    const range = presetRange('24h', new Date('2026-10-08T10:30:00Z'));
    expect(range.to).toBe('2026-10-08T11:00:00.000Z');
    expect(range.from).toBe('2026-10-07T11:00:00.000Z');
  });

  test('now on the hour is still included', () => {
    const range = presetRange('7d', new Date('2026-10-08T10:00:00Z'));
    expect(range.to).toBe('2026-10-08T11:00:00.000Z');
  });

  test('a custom range is inclusive of the last day and rejects bad input', () => {
    const range = customRange('2026-10-01', '2026-10-01');
    expect(range).not.toBeNull();
    expect(Date.parse(range?.to ?? '') - Date.parse(range?.from ?? '')).toBe(
      24 * 3_600_000,
    );
    expect(customRange('', '2026-10-01')).toBeNull();
    expect(customRange('2026-10-02', '2026-10-01')).toBeNull();
  });

  test('hours for up to two days, days beyond', () => {
    expect(intervalFor(presetRange('24h'))).toBe('hour');
    expect(intervalFor(presetRange('7d'))).toBe('day');
  });

  test('the query carries the project only when one is chosen', () => {
    const range = {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
    };
    expect(rangeQuery(range, '')).not.toContain('projectId');
    expect(rangeQuery(range, 'p1', { dimension: 'model' })).toContain(
      'projectId=p1',
    );
    expect(rangeQuery(range, '', { tz: undefined })).not.toContain('tz');
  });
});

describe('money', () => {
  test('no figure is blank, never $0', () => {
    expect(formatUsd(null)).toBe('');
    expect(costOrBlank('0.000000', 3, 3)).toBe('');
    expect(costOrBlank('0.000000', 0, 0)).toBe('$0.00');
    expect(costOrBlank('1.50', 4, 1)).toBe('$1.50');
  });

  test('small and large values', () => {
    expect(formatUsd('0.004')).toBe('<$0.01');
    expect(formatUsd('1234.5')).toBe('$1,234.50');
  });

  test('absent dimension values are named', () => {
    expect(groupLabel('project', null, null)).toBe('No project (machine-wide)');
    expect(groupLabel('slot', null, null)).toBe('None');
    expect(groupLabel('issue', null, '13')).toBe('#13');
    expect(groupLabel('project', 'AgentDock', 'p1')).toBe('AgentDock');
  });
});

describe('price forms', () => {
  test('per-token and per-million convert both ways without float noise', () => {
    expect(perMillion('0.000003')).toBe('3');
    expect(perMillion('0.0000000375')).toBe('0.0375');
    expect(perToken('3')).toBe('0.000003');
    expect(perToken('0.0375')).toBe('0.0000000375');
    expect(perToken('0')).toBe('0');
    expect(perToken('-1')).toBeNull();
    expect(perToken('abc')).toBeNull();
    expect(perToken('')).toBeNull();
  });

  const model: ModelPriceInput = {
    modelName: 'claude-sonnet-4-5',
    matchPattern: '^claude-sonnet-4-5',
    priority: 0,
    tiers: [
      {
        name: 'Long context',
        isDefault: false,
        conditions: [{ bucket: 'totalInput', op: 'gt', value: 200000 }],
        prices: { input: '0.000006', output: '0.0000225' },
      },
      {
        name: 'Standard',
        isDefault: true,
        conditions: [],
        prices: { input: '0.000003', output: '0.000015' },
      },
    ],
  };

  test('editing rewrites only the default tier and keeps the others', () => {
    const form = { ...formFromModel(model), input: '4' };
    const result = modelFromForm(form, model);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.tiers).toHaveLength(2);
    expect(result.model.tiers[0]).toBe(model.tiers[0]);
    expect(result.model.tiers[1]?.prices.input).toBe('0.000004');
    expect(result.model.tiers[1]?.prices.output).toBe('0.000015');
  });

  test('a new model gets one default tier', () => {
    const result = modelFromForm({
      modelName: 'm',
      matchPattern: '^m',
      priority: '1',
      input: '1',
      output: '2',
      cacheRead: '0.1',
      cacheWrite5m: '',
      cacheWrite1h: '',
      reasoning: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.tiers).toEqual([
      {
        name: 'Standard',
        isDefault: true,
        conditions: [],
        prices: {
          input: '0.000001',
          output: '0.000002',
          cacheRead: '0.0000001',
        },
      },
    ]);
  });

  test('a seeded (?i) pattern is accepted and matches case-insensitively', () => {
    const seeded = { ...model, matchPattern: '(?i)^(claude-sonnet-4-5)$' };
    expect(modelFromForm(formFromModel(seeded), seeded).ok).toBe(true);
    expect(compilePattern(seeded.matchPattern).test('CLAUDE-sonnet-4-5')).toBe(
      true,
    );
    expect(() => compilePattern('(')).toThrow();
  });

  test('bad input is named', () => {
    const base = formFromModel(model);
    const error = (patch: Partial<typeof base>) => {
      const result = modelFromForm({ ...base, ...patch });
      return result.ok ? null : result.error;
    };
    expect(error({ modelName: ' ' })).toMatch(/Model name/);
    expect(error({ matchPattern: '(' })).toMatch(/valid regex/);
    expect(error({ priority: '-1' })).toMatch(/Priority/);
    expect(error({ output: '' })).toMatch(/Input and output/);
    expect(error({ cacheRead: 'x' })).toMatch(/cacheRead/);
  });
});
