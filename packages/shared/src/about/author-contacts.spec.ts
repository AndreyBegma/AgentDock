import { describe, expect, test } from 'bun:test';
import { AUTHOR_CONTACTS, presentContacts } from './author-contacts';

describe('presentContacts', () => {
  test('keeps GitHub and Telegram, skips the empty LinkedIn and email', () => {
    expect(presentContacts().map((contact) => contact.kind)).toEqual([
      'github',
      'telegram',
    ]);
  });

  test('an entry whose link is blank is skipped', () => {
    const [github] = AUTHOR_CONTACTS;
    if (!github) throw new Error('GitHub contact expected');
    expect(presentContacts([{ ...github, href: '  ' }])).toEqual([]);
  });
});
