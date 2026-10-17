# C-239: Add the assistant launcher and floating chat window to the web app

Issue: #618

## What to do
Mount the glass-ui `Launcher` and `FloatingWindow` in the authenticated layout of `apps/web` so the assistant is available on every screen. On phones it opens as a `Sheet` that stays above the bottom capsule (PR #535).

Inside the window:
- **Rail.** Conversations grouped Today / Yesterday / Previous 7 days / Earlier.
  - Port `luna-projects/luna-watch/apps/web/src/lib/chat/group-conversations.ts` with its tests, grouping by calendar day in the person's timezone.
  - New, rename and delete actions.
- **Thread.** glass-ui `ChatThread`, rendering markdown and streamed tokens. Tool activity appears as blocks: a link to a created card, the approval state of a requested action.
- **Composer.**
  - Attach a card, an agent session (opted-in projects only) or a file.
  - A model picker with the enabled models.
  - A project picker with an Auto option.
- **Cap reached.** A message naming the provider and the reset date.

## Acceptance criteria
- [ ] The launcher is on every authenticated screen and opens the window.
- [ ] The window can be dragged and resized, and its position and size persist after a reload.
- [ ] On phone widths, a sheet opens without overlapping the capsule.
- [ ] Date groups use calendar days, and the ported tests cover the boundaries.
- [ ] Replies stream token by token, with markdown.
- [ ] A card, a session and a file can be attached; the session option is hidden for projects without session content.
- [ ] The model and project pickers apply to the next message, and Auto is the default.
- [ ] Only glass-ui components are used.

## Out of scope
- Server changes beyond wiring.
- Telegram.

## Open questions
None.
