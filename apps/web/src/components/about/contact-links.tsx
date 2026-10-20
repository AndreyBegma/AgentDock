import {
  AUTHOR_CONTACTS,
  type AuthorContact,
  type AuthorContactKind,
  presentContacts,
} from '@nautelle/shared';
import {
  Briefcase,
  GitBranch,
  type LucideIcon,
  Mail,
  Send,
} from 'lucide-react';

/** lucide 1.x carries no brand marks: a plain sign for each network. */
export const CONTACT_ICON: Record<AuthorContactKind, LucideIcon> = {
  github: GitBranch,
  telegram: Send,
  linkedin: Briefcase,
  email: Mail,
};

/** An author link leaves the app: a new tab that cannot reach back. */
export const EXTERNAL_LINK = {
  target: '_blank',
  rel: 'noopener noreferrer',
} as const;

/** "GitHub: AndreyBegma" — the name a screen reader reads for an icon link. */
export const contactName = (contact: AuthorContact): string =>
  contact.handle ? `${contact.label}: ${contact.handle}` : contact.label;

/**
 * The About page's Contacts rows (C-293): an icon, the network and the
 * handle, the whole row a link. An entry without a link is not rendered.
 */
export function ContactList({
  contacts = AUTHOR_CONTACTS,
}: {
  contacts?: readonly AuthorContact[];
}) {
  const shown = presentContacts(contacts);
  return (
    <ul className="divide-y divide-line">
      {shown.map((contact) => {
        const Icon = CONTACT_ICON[contact.kind];
        return (
          <li key={contact.kind}>
            <a
              href={contact.href}
              {...EXTERNAL_LINK}
              aria-label={contactName(contact)}
              className="flex min-h-(--size-tap) items-center gap-3 px-4 py-2 text-sm text-ink hover:bg-hover"
            >
              <Icon size={16} className="shrink-0 text-ink-3" aria-hidden />
              <span className="w-24 shrink-0 text-ink-2">{contact.label}</span>
              <span className="min-w-0 truncate">{contact.handle}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
