import { describe, expect, test } from 'bun:test';
import { AUTHOR_CONTACTS, presentContacts } from './author-contacts';

describe('presentContacts', () => {
  test('keeps GitHub, Telegram and email, skips the empty LinkedIn', () => {
    expect(presentContacts().map((contact) => contact.kind)).toEqual([
      'github',
      'telegram',
      'email',
    ]);
  });

  test('email is a mailto link to the author (#743)', () => {
    expect(AUTHOR_CONTACTS.find((each) => each.kind === 'email')).toEqual({
      kind: 'email',
      label: 'Email',
      handle: 'abegma137@gmail.com',
      href: 'mailto:abegma137@gmail.com',
    });
  });

  test('an entry whose link is blank is skipped', () => {
    const [github] = AUTHOR_CONTACTS;
    if (!github) throw new Error('GitHub contact expected');
    expect(presentContacts([{ ...github, href: '  ' }])).toEqual([]);
  });
});
