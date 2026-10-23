# C-305: Restore the author contacts in the account menu and add the email

Issue: #743

## What to do

C-293 (commit 2e9f7583) added an **About** entry and the author's contact links (`presentContacts()` rendered as new-tab anchors with `CONTACT_ICON`, `contactName`, `EXTERNAL_LINK`) to the avatar menu, then inline in `apps/web/src/components/shell/app-shell.tsx`. A parallel change, C-294 (commit 4bba224c), moved that menu into `apps/web/src/components/shell/account-menu.tsx`, and the merge dropped the C-293 entries. Today the menu shows Account, Admin, What's new, Theme and Log out, but no About and no contacts. The `/account/about` page and `ContactList` (`apps/web/src/components/about/contact-links.tsx`) still exist.

1. In `account-menu.tsx`, put back what C-293 added: a separator, an **About** item (lucide `Info`) that routes to `/account/about`, and one `MenuItem asChild` anchor for each `presentContacts()` entry, with its icon from `CONTACT_ICON`, `aria-label={contactName(contact)}` and `{...EXTERNAL_LINK}`. Place them as C-293 did: after the What's new / Theme block and before the separator above Log out. Use the existing helpers from `contact-links.tsx` and add no new markup patterns.
2. In `packages/shared/src/about/author-contacts.ts`, fill in the `email` entry: `handle: 'abegma137@gmail.com'`, `href: 'mailto:abegma137@gmail.com'`. Update the doc comment that says email waits for the Nautelle domain. LinkedIn stays empty.

## Acceptance criteria

- [ ] Opening the avatar menu shows the About entry and the GitHub, Telegram and Email contact links again (the reproduction from the screenshot no longer reproduces).
- [ ] About navigates to `/account/about`; each contact is a real `<a>` that opens in a new tab with `rel="noopener noreferrer"` and has an accessible name such as `Email: abegma137@gmail.com`.
- [ ] `AUTHOR_CONTACTS` has the email entry with `href` `mailto:abegma137@gmail.com` and handle `abegma137@gmail.com`; `/account/about` lists it.
- [ ] LinkedIn, which still has no link, is not rendered anywhere.
- [ ] A test next to `account-menu.tsx` (e.g. `account-menu.test.tsx`) checks that About and the present contacts render in the menu, so another refactor cannot drop them silently; the shared `author-contacts.spec.ts` and `contact-links.test.tsx` are updated for the email entry.
- [ ] `bun run check` and the web and shared tests pass.

## Out of scope

- Adding the LinkedIn URL or any other new contact.
- Redesigning the account menu or the About page.
- Showing contacts on the landing or in the docs.

## Open questions

None.
