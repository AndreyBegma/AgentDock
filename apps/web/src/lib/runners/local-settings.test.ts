import { describe, expect, test } from 'bun:test';
import { localUserOptions, userOptionLabel } from './local-settings';

const ann = { id: 'u1', email: 'ann@example.com', name: 'Ann' };
const bob = { id: 'u2', email: 'bob@example.com', name: null };

describe('userOptionLabel', () => {
  test('name and email, or the email alone', () => {
    expect(userOptionLabel(ann)).toBe('Ann (ann@example.com)');
    expect(userOptionLabel(bob)).toBe('bob@example.com');
  });
});

describe('localUserOptions', () => {
  test('lists the users as given', () => {
    expect(localUserOptions([ann, bob], 'u1').map((o) => o.id)).toEqual([
      'u1',
      'u2',
    ]);
  });
  test('keeps a saved user that is not in the list visible', () => {
    const options = localUserOptions([ann], 'abcdefghijkl');
    expect(options.at(-1)).toEqual({
      id: 'abcdefghijkl',
      label: 'Unknown user (abcdefgh)',
    });
  });
  test('adds nothing for no saved user', () => {
    expect(localUserOptions([ann], null)).toHaveLength(1);
  });
});
