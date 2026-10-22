import { describe, expect, test } from 'bun:test';
import { AUTHOR_CONTACTS, type AuthorContact } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContactList, contactName } from './contact-links';

const contact = (kind: AuthorContact['kind'], href: string): AuthorContact => ({
  kind,
  label: kind,
  handle: href ? `${kind}-handle` : '',
  href,
});

describe('ContactList (C-293)', () => {
  test('renders GitHub, Telegram and email as new-tab links with accessible names', () => {
    const html = renderToStaticMarkup(<ContactList />);
    expect(html).toContain('href="https://github.com/AndreyBegma"');
    expect(html).toContain('href="https://t.me/abegma"');
    expect(html).toContain('aria-label="GitHub: AndreyBegma"');
    expect(html).toContain('aria-label="Telegram: @abegma"');
    expect(html).toContain('href="mailto:abegma137@gmail.com"');
    expect(html).toContain('aria-label="Email: abegma137@gmail.com"');
    expect(html).toContain('>@abegma</span>');
    expect(html.match(/target="_blank"/g)).toHaveLength(3);
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(3);
  });

  test('skips the entry without a link (LinkedIn)', () => {
    const html = renderToStaticMarkup(<ContactList />);
    expect(html).not.toContain('LinkedIn');
    expect(html.match(/<a /g)).toHaveLength(
      AUTHOR_CONTACTS.filter((each) => each.href).length,
    );
  });

  test('an entry gains a row once its link is filled in', () => {
    const html = renderToStaticMarkup(
      <ContactList
        contacts={[
          contact('linkedin', 'https://linkedin.com/in/x'),
          contact('email', ''),
        ]}
      />,
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="https://linkedin.com/in/x"');
  });

  test('the accessible name falls back to the label without a handle', () => {
    expect(
      contactName({ ...contact('email', 'mailto:a@b.c'), handle: '' }),
    ).toBe('email');
  });
});
