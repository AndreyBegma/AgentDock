/** Where an author contact leads; the web app picks an icon by it. */
export type AuthorContactKind = 'github' | 'telegram' | 'linkedin' | 'email';

export interface AuthorContact {
  kind: AuthorContactKind;
  /** The network's name, the accessible name of an icon link ("GitHub"). */
  label: string;
  /** What a reader sees beside the label (`@abegma`). */
  handle: string;
  /** Empty until the person sends it: such an entry is not rendered. */
  href: string;
}

/**
 * The author's links (C-293) — one source for the web app, the docs and the
 * landing. LinkedIn waits for its URL and stays here empty so that filling
 * `href` is the whole change.
 */
export const AUTHOR_CONTACTS: readonly AuthorContact[] = [
  {
    kind: 'github',
    label: 'GitHub',
    handle: 'AndreyBegma',
    href: 'https://github.com/AndreyBegma',
  },
  {
    kind: 'telegram',
    label: 'Telegram',
    handle: '@abegma',
    href: 'https://t.me/abegma',
  },
  { kind: 'linkedin', label: 'LinkedIn', handle: '', href: '' },
  {
    kind: 'email',
    label: 'Email',
    handle: 'abegma137@gmail.com',
    href: 'mailto:abegma137@gmail.com',
  },
];

/** The contacts that have a link, in order; an entry without one is skipped. */
export const presentContacts = (
  contacts: readonly AuthorContact[] = AUTHOR_CONTACTS,
): AuthorContact[] => contacts.filter((contact) => contact.href.trim() !== '');
