import { describe, expect, test } from 'bun:test';
import { entityIdOrUndefined, isEntityId } from './ids';

describe('ids from the URL (C-165)', () => {
  test('a cuid and a uuid are ids', () => {
    expect(isEntityId('cmvb25vkn01i501o68v2unmem')).toBe(true);
    expect(isEntityId('0b8f6a4e-1c2d-4e5f-9a8b-7c6d5e4f3a2b')).toBe(true);
  });

  test.each([
    '',
    '..',
    '../../Q',
    '..%2F..%2FQ',
    'a/b',
    'a\\b',
    'a.b',
    'x'.repeat(65),
  ])('%p is not', (value) => {
    expect(isEntityId(value)).toBe(false);
    expect(entityIdOrUndefined(value)).toBeUndefined();
  });

  test('a missing parameter stays missing', () => {
    expect(entityIdOrUndefined(null)).toBeUndefined();
    expect(entityIdOrUndefined(undefined)).toBeUndefined();
    expect(entityIdOrUndefined('c1')).toBe('c1');
  });
});
