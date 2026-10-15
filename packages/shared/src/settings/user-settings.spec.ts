import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_MODEL_ALIASES,
  isPlanningModel,
  PLANNING_MODEL_DEFAULT,
  resolvePlanningModel,
} from '../index';

/** #337 D9: the planning model. */

describe('the planning model', () => {
  it('defaults to sonnet, a catalog alias', () => {
    expect(PLANNING_MODEL_DEFAULT).toBe('sonnet');
    expect(CLAUDE_MODEL_ALIASES).toContain(PLANNING_MODEL_DEFAULT);
  });

  it('resolves no row, a cleared or blank value to the default', () => {
    expect(resolvePlanningModel(undefined)).toBe('sonnet');
    expect(resolvePlanningModel(null)).toBe('sonnet');
    expect(resolvePlanningModel('  ')).toBe('sonnet');
    expect(resolvePlanningModel('opus')).toBe('opus');
  });

  it('accepts a catalog alias or null, nothing else', () => {
    for (const alias of CLAUDE_MODEL_ALIASES) {
      expect(isPlanningModel(alias)).toBe(true);
    }
    expect(isPlanningModel(null)).toBe(true);
    expect(isPlanningModel('gpt-5')).toBe(false);
    expect(isPlanningModel('--dangerously-skip-permissions')).toBe(false);
  });
});
