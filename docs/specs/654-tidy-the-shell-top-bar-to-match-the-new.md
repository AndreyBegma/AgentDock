# C-260: Tidy the shell top bar to match the new Work header

Issue: #654

## What to do
Restyle the shell top bar to match the approved mockup and the new Work header. It currently looks cluttered.

The top bar is rendered by the app shell: `apps/web/src/components/shell/app-shell.tsx` and `capsule.tsx`. It holds:
- breadcrumbs (`crumbs.ts`)
- the live-status dot
- the ⌘K search trigger
- the notification bell with its unread count (`notification-bell.tsx`)
- the user avatar

Goals:
- Align these elements on one baseline, with consistent spacing and sizes.
- Make the unread badge read cleanly at large counts. The screenshot shows 96 overlapping the bell; show a cap such as "99+" past two digits.
- Make the live dot's meaning clear, for example a tooltip.

Use glass-ui components only (ADR-0011).

## Acceptance criteria
- [ ] The top bar matches the approved mockup on the Work views and looks the same on every other page that uses the shell.
- [ ] Breadcrumbs, live dot, search trigger, bell and avatar share one vertical alignment and consistent spacing.
- [ ] The unread badge does not overlap or clip the bell icon at 1, 2 and 3+ digit counts; counts above 99 show as "99+".
- [ ] The live-status dot has an accessible label or tooltip that says what it means.
- [ ] Keyboard behaviour is unchanged: ⌘K opens search, and focus order and labels are kept. `bun run check` and `bun run build` pass.

## Out of scope
- What the top bar contains and does: navigation, notification logic, search behaviour.
- The Work page header below the top bar.
- The left rail.

## Open questions
None.
