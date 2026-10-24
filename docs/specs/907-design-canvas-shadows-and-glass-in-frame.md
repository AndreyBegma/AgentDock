# C-379: Design canvas: shadows and glass in frames flicker and jitter while panning, depending on zoom

Issue: #907

## What the person sees
Screenshot (S-12 design, Desktop 1440×900 frame): https://filesdrop.luna-realm.com/f/w6uwVfar.png
- In a design frame on the canvas, shadows and glass surfaces (box-shadow, `backdrop-filter` blur of glass-ui) are "torn" and flicker. On the screenshot a band of the page is drawn over itself: the title is cut on the left ("d usage export…"), a light panel covers the left edge, and the sidebar's bottom fades in a wrong rectangle.
- While panning, they jitter hard.
- It depends on the zoom: at some zoom levels it stops (e.g. after zooming the frame in), at others it starts. Hovering inside the frame can start or stop it too.

## Where
`apps/web/src/components/canvas/frame-canvas.tsx` (FrameCanvas, #866 / S-10): the world layer is `absolute origin-top-left will-change-transform` with `transform: translate(${pan.x}px, ${pan.y}px) scale(${scale})` (~line 420), and every frame is an `<iframe>` of the mockup HTML inside it. The same `scale()` pattern is in `scaled-preview.tsx` and `compare-grid.tsx`.

## Likely cause (to confirm first)
Chromium rasters a `will-change: transform` layer once at one scale and then only moves/scales the bitmap. The iframes inside it are composited layers of their own, and the mockups use `backdrop-filter` and large blurred shadows. A backdrop-filter inside a scaled, will-change layer gets its backdrop at a mismatched scale and gets re-rastered tile by tile while the pan changes. Panning by fractional px (`pan.x/y` are not rounded) makes it worse. A zoom change re-rasters the layer, so the glitch comes and goes with the zoom. A hover triggers a repaint inside the iframe, so it does the same.

## Fix directions (pick from measurements, not guesses)
1. Round the pan to device pixels (`Math.round(x * dpr) / dpr`). Keep `translate3d` for the pan.
2. Drop `will-change-transform` while the canvas rests: set it only during an active pan or pinch gesture, then remove it so Chromium re-rasters crisp at the final scale. Or switch it on and off around a gesture with a short debounce.
3. Render each frame at its device size and scale the iframe element itself (one transform per frame), not one transform for the whole world. Compare the glitch and the cost.
4. If (1)–(3) do not cure the glass inside iframes: while a pan or zoom gesture is moving, show a static snapshot of each frame and restore the live iframe on rest.
Check Chrome and Safari (WebKit), dpr 1 and 2. Also check the comment pins and labels still line up (they use `1/scale`).

## Done when
On the S-12 design and on one more glass-heavy design, at 25 %, 50 %, 75 %, 100 % and 150 %:
- no torn bands;
- no flicker while panning or hovering;
- shadows stay stable.

Record before and after (a screen recording or Playwright screenshots at each zoom). Add a regression test where one is possible: pan rounding and the will-change toggling are pure logic, so test them as unit tests.
