# Zoom in the design viewer

Issue: [#335](https://github.com/AndreyBegma/Nautelle/issues/335) · Extends [spec 223](223-design-stage.md) D11

## Summary

The design viewer draws the mockup frame at the preset's CSS width. On a
laptop, Desktop 1440×900 is wider than the space left beside the comments
panel, so the person scrolls sideways to see the page. The product owner asked
(2026-10-15) for a zoom like a browser's DevTools device mode, so that a 1440
mockup fits on the screen while it still lays out at 1440.

## Scope

### In scope

- A zoom on the viewer toolbar:
  - **Fit**, the default;
  - the presets 50, 75, 100 and 125 %;
  - − / + buttons in steps of 10 %;
  - `Ctrl`/`⌘` + wheel and `Ctrl`/`⌘` + `0` / `-` / `=` over the stage.
- The mockup keeps its layout width and height. Only its rendering is scaled.
- Pins, edge-drag and the pin composer keep working at any zoom.

### Out of scope

- Zooming the mockup's content in a way that changes its layout (that is a
  different width).
- Device frames and a rotate control.
- Remembering the zoom per user across designs.

## Decisions

- **D1 — Scale, not resize.** The `iframe` keeps `width` = the viewer width
  and `height` = the preset height. It is drawn with `transform: scale(z)`
  and `transform-origin: top left` inside a box sized `width·z × height·z`,
  so the page around it lays out at the scaled size.
- **D2 — Fit is the default.** z = min(1, available stage width ÷ frame
  width), recomputed on stage resize (`ResizeObserver`).
  - Fit never zooms above 100 %.
  - The toolbar shows the effective percent, e.g. `Fit · 72 %`.
  - Choosing a preset or a step leaves Fit; choosing Fit again returns to it.
- **D3 — Bounds.** z ∈ [0.25, 2], rounded to whole percents. The steps are
  10 %; the wheel is proportional and clamped.
- **D4 — In the URL.** The viewer state gains `zoom`: `fit` or a number such
  as `0.75`, next to `width` and `viewport`, through `viewer-state.ts`
  (`applyViewerChange`, a new `{ kind: 'zoom' }`). A shared link opens at the
  same zoom.
- **D5 — Coordinates.**
  - The pin composer anchors at `frame.left + clientX·z`,
    `frame.top + clientY·z`. `clientX/Y` come from inside the frame, in
    unscaled CSS pixels, and `frame` is the scaled bounding box.
  - Markers drawn inside the mockup need no change.
  - Dragging the frame's edge converts the pointer delta to layout pixels
    (`Δ / z`), so the typed width stays the layout width.
- **D6 — Shortcuts.** `Ctrl`/`⌘` + wheel and `Ctrl`/`⌘` + `0`/`-`/`=` act
  only while the pointer or focus is on the stage, and call `preventDefault`
  there so the browser page does not zoom. Outside the stage they do
  nothing. `0` returns to Fit.
- **D7 — Components.** The zoom control is a glass-ui segmented control or
  select with buttons. A missing part goes to glass-ui (ADR-0011).

## UI

- `viewer-toolbar.tsx`: the zoom control after the width field.
- `design-viewer.tsx` / `mockup-frame.tsx`: the scaled box (D1), Fit (D2),
  the edge-drag conversion (D5) and the stage shortcuts (D6).
- `pin-composer.tsx`: the anchor uses z (D5).
- `apps/web/src/lib/design/viewer-state.ts`: the `zoom` state, parsing and
  serialising (D4).
- `docs/ui/screens.md`: the design viewer row.

## Acceptance criteria

- [ ] Desktop 1440×900 on a stage 1000 px wide opens at **Fit ≈ 69 %**. The
  whole page width is visible with no horizontal scroll, and the mockup's own
  `window.innerWidth` is still 1440 (asserted from a test page that reports
  it).
- [ ] Mobile 390×844 on the same stage opens at Fit = 100 %. It is never
  upscaled.
- [ ] Choosing 50 %, then −, then + gives 50 → 40 → 50. The URL carries
  `zoom=0.5`, and reloading keeps it.
- [ ] Choosing Fit, or `Ctrl+0` on the stage, returns to Fit. `Ctrl+wheel`
  outside the stage does not change the zoom and is not prevented.
- [ ] At 50 %, a pin-mode click opens the composer at the clicked point
  (within 4 px). The saved pin's marker shows at the same place at 100 %.
- [ ] At 50 %, dragging the frame edge by 100 screen px changes the width by
  200 layout px.
- [ ] `viewer-state.ts` unit tests cover the `zoom` parsing (out of range →
  clamped, garbage → Fit) and the round-trip.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i335-web | the zoom | apps/web/src/components/design/**, apps/web/src/lib/design/**, docs/ui/screens.md | — | yes | sonnet |

One slot: the change is one component tree and its state.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| docs/ui/screens.md | i335-web | append only its own row; rebase on conflict |

## Risks

- **Low — fractional scaling blurs text** at odd percents. *Mitigation:* the
  rounding of D3; Fit shows the true percent.
- **Low — a mockup that listens to `wheel` with Ctrl.** *Mitigation:* the
  stage handler sits outside the iframe, so the sandboxed document's own
  handlers are not affected. Events inside the iframe never reach the parent,
  so the shortcuts work over the frame's margin and the toolbar focus only.
  This limit is stated in the UI hint.

Depends on #223 (shipped)
