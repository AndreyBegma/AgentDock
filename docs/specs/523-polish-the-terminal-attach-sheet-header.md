# C-228: Polish the terminal attach sheet: header, message line, spacing, theme

Issue: #523

## What to do
Polish the look of the terminal attach sheet: the right-side sheet that opens when a person attaches to a running session (Board card, plan task or slot). The code is in `apps/web/src/components/terminal/terminal-sheet.tsx` and `apps/web/src/components/terminal/terminal-view.tsx`, and the message line is `apps/web/src/components/session/session-message-line.tsx`. This is a styling pass only. The structure and the behaviour stay as they are.

- **Header.** Remove the uninformative `Terminal attach` subtitle, or replace it with something useful such as the target kind. Put the connection status (dot + label) and the `read-only` / `in control` chip into one compact, aligned status group. Keep **Take control** / **Release** and **Detach** visually distinct: Detach is secondary and Take control is the primary action. The header must not wrap awkwardly at the sheet's widths.
- **Message line.** The `Message <title>…` line under the terminal currently reads like a second prompt right under Claude's own prompt. Separate it visually from the terminal (spacing and/or a divider, a clear label or placeholder) so it is obviously Nautelle's channel to the session (#489), not part of the terminal output. The Send button aligns with the input.
- **Size and spacing.** Revisit the sheet width (`sm:w-[min(100vw,60rem)]`), the padding around the terminal, the gaps between header / banners / terminal / message line, and the terminal font size / line height, so the terminal gets as much room as possible and the sheet looks balanced on desktop and mobile.
- **Terminal theme.** The xterm instance in `terminal-view.tsx` sets only background, foreground, cursor and selection. ANSI colours fall back to xterm defaults, which gives the harsh saturated blue and red diff blocks, and the background reads as navy against the glass sheet. Give xterm a full 16-colour ANSI palette (plus a neutral background) derived from glass-ui tokens (read through the existing `cssVar` helper, with fallbacks), so diffs and highlights are muted and fit the sheet.

Use only glass-ui components and tokens (ADR-0011). If something is missing, it goes into glass-ui and is not hand-written here.

## Acceptance criteria
- [ ] The sheet no longer shows the `Terminal attach` subtitle, or it shows meaningful text in its place.
- [ ] Status dot, status label and mode chip sit in one aligned group, and Take control / Release is visually primary while Detach is secondary. Both stay on one row at 60rem and wrap cleanly on a narrow (mobile) viewport.
- [ ] The message line is visually separated from the terminal and is clearly not part of the terminal output. Input and Send button are aligned, and the line still appears only in read-only mode when `message` is passed.
- [ ] Terminal padding and the gaps between header, banners, terminal and message line are consistent, and the terminal fills the remaining height with no dead space.
- [ ] The xterm theme defines all 16 ANSI colours and the background from glass-ui tokens. A Claude Code diff (red/green/blue lines) renders in muted colours, and the terminal background matches the sheet surface instead of reading as navy.
- [ ] Behaviour is unchanged: opening is read-only, Take control re-attaches in write mode with the danger banner, Detach closes, reconnect/retry banners still work, and resize still sends the new size.
- [ ] Before/after screenshots of the sheet in read-only and in-control modes, desktop and mobile width, are attached to the PR.
- [ ] `bun run check` and the web build pass.

## Out of scope
- Changing terminal behaviour, the attach protocol, modes or the message-sending logic.
- A full redesign or a new layout of the sheet. This is a polish of the existing structure.
- Restyling other screens that use `SessionMessageLine` beyond what the shared component needs, and anything other than an additive change to its API.

## Open questions
None.
