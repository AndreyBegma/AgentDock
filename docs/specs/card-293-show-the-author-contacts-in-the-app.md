# C-293: Show the author contacts in the app

## What to do
Add a small, calm "Contacts" block with the author's links, using glass-ui components only (ADR-0011):
- GitHub: https://github.com/AndreyBegma
- Telegram: https://t.me/abegma (shown as `@abegma`)
- LinkedIn: the person sends the URL; until then the entry is not rendered.
- Email: added after the rename to Nautelle, on the new domain; until then it is not rendered.

Keep the links in one typed constant in `packages/shared` (for example `AUTHOR_CONTACTS`), so the web app, the docs and the landing can use one source. An entry without a value is skipped.

Show it in:
- the app footer or account menu, as icon links with accessible names;
- a short "About" section (product name, version, links) reachable from the account menu or Settings.

Follow the S-7 calm layout (`Section`, `PageHeader` from glass-ui 0.37). Links open in a new tab with `rel="noopener noreferrer"`.

## Acceptance criteria
- [ ] GitHub and Telegram links render in the footer or account menu and in About, on phone, tablet and desktop.
- [ ] Empty entries (LinkedIn, email) are not rendered.
- [ ] The contacts live in one constant in `packages/shared`.
- [ ] A web test covers the rendering and the skipping of empty entries.
- [ ] `bun run check` passes.

## Out of scope
- The landing page (the person updates it).

## Open questions
- LinkedIn URL. Default: omitted until the person sends it.
