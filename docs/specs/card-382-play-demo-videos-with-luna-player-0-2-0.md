# C-382: Play demo videos with luna-player 0.2.0 and bump glass-ui to 0.38.0

## Why
C-371 (stack S-12) shipped the demo `VideoPlayer` adapter with a native `<video>` fallback, because luna-player had no player component yet (ADR-0090 §7). On 2026-10-24 `luna-player@0.2.0` went out with `<Player>` in `luna-player/player`, and `@andrewbehma/glass-ui@0.38.0` went out too. 0.38.0 only adds components: Tour (coachmarks with a spotlight) and ColorPicker. Runs after C-371 (#915) is merged.

## What
1. **glass-ui 0.37.0 → 0.38.0** in `apps/web`, pinned exactly (`bunfig.toml` exact versions). Then `bun install`, a fresh `bun.lock`, `bun run check`, a web build and `bun test --cwd apps/web`. Fix anything the bump breaks.
2. **luna-player 0.2.0**, pinned exactly, in `apps/web`. Peers: react 19, react-dom 19, hls.js ^1.5, glass-ui >=0.20, lucide-react, motion >=12, tailwindcss 4. Add a peer only if it is missing. hls.js is needed only if `luna-player/hls` is imported, so do not import it: demos are progressive MP4/WebM.
3. **CSS through Tailwind, as its README requires.** Import `luna-player/player.css` from the web app's Tailwind entry CSS, and add the package to Tailwind's sources so its classes get generated. A JS `import 'luna-player/player.css'` is not supported.
4. **Switch the adapter** (`apps/web/src/components/demos/video-player.tsx`). `loadLunaPlayer` becomes a dynamic `import('luna-player/player')` that maps our props onto `<Player>`:
   - `src` → `src`, `title` → `title`, `aspectRatio="16:9"`, `storage={null}` (no localStorage on the card) or the default;
   - `onError` → fall back to the native `<video>`.
   Keep the native fallback for load failure and playback errors. Update `video-player.test.tsx`: Luna is used when it loads, the native element when the import rejects or `onError` fires.
5. Docs: update ADR-0090 §7 with a short amendment line saying Luna is now used, and the decisions log of the card spec. Add before/after screenshots of the card's Demo section in light, dark and phone width to `docs/ui/screens.md`, using the seeded dev DB as in C-371.

## Done when
On a Finished card with a ready demo, the video plays in luna-player and seeks over Range. The native fallback works when Luna fails. glass-ui is 0.38.0. `bun run check`, the web tests and the build all pass.

## Decisions log
- 2026-10-24: glass-ui is pinned to 0.38.0 and luna-player to 0.2.0 in `apps/web`. All of luna-player's peers (react, react-dom, hls.js is optional, glass-ui, lucide-react, motion, tailwindcss, and glass-ui's Radix slider and tooltip) were already installed, so no peer was added.
- `luna-player/player.css` is imported from `globals.css`, after glass-ui's imports; its `@source` makes Tailwind generate the player's classes. No JS import of the CSS.
- `loadLunaPlayer` wraps `<Player>` with `aspectRatio="16:9"` and `storage={null}`, so the card writes nothing to localStorage. `luna-player/hls` is not imported, so hls.js stays out of the bundle.
- A playback error is remembered per source (`failedSrc`): that recording falls back to the native `<video>`, while another demo on the card gets Luna again.
- The web tests have no DOM library, so the swap is a pure `PlayerSwitch` component tested with server rendering; the `onError` wiring is checked by calling the prop the switch passes to Luna.
