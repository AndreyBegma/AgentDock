import { z } from 'zod';
import { DESIGN_SELECTOR_MAX } from './limits';
import { designThemeSchema } from './types';

/**
 * The pin helper (docs/specs/223-design-stage.md D9, D11): a script the
 * mockup endpoint injects before `</body>`, and the `postMessage` protocol
 * between it and the viewer. The helper is never part of a published file.
 *
 * The mockup runs in an opaque origin (`sandbox allow-scripts`), so neither
 * side can name the other's origin: messages go with target `*` and carry no
 * secret, and each side accepts a message only from the window it expects —
 * the viewer from `iframe.contentWindow`, the helper from `window.parent`.
 * A mockup's own script shares the helper's window and could imitate it;
 * the validator refuses `parent.postMessage` in a mockup, and the worst a
 * forged message does is open a comment box.
 */

/** `source` of every message the helper sends. */
export const MOCKUP_MESSAGE_SOURCE = 'agentdock-mockup';
/** `source` of every message the viewer sends. */
export const VIEWER_MESSAGE_SOURCE = 'agentdock-viewer';

const coordinate = z.number().finite().min(0).max(1_000_000);

/** A pin marker the helper draws, in document coordinates. */
export const mockupPinMarkerSchema = z.strictObject({
  /** The number shown on the marker. */
  n: z.number().int().min(1).max(10_000),
  x: coordinate,
  y: coordinate,
});
export type MockupPinMarker = z.infer<typeof mockupPinMarkerSchema>;

/** Viewer → mockup. */
export const viewerMessageSchema = z.discriminatedUnion('type', [
  /** Flips `data-theme` on `:root` without reloading the frame. */
  z.strictObject({
    source: z.literal(VIEWER_MESSAGE_SOURCE),
    type: z.literal('theme'),
    theme: designThemeSchema,
  }),
  /** Pin mode: a crosshair cursor, and a click becomes a `pin` message. */
  z.strictObject({
    source: z.literal(VIEWER_MESSAGE_SOURCE),
    type: z.literal('pin-mode'),
    on: z.boolean(),
  }),
  /** Replaces the markers drawn: the pins of the current viewport and theme. */
  z.strictObject({
    source: z.literal(VIEWER_MESSAGE_SOURCE),
    type: z.literal('pins'),
    pins: z.array(mockupPinMarkerSchema).max(500),
    /**
     * The viewer's zoom, sent on touch screens only. With it the helper draws
     * each marker at a fixed on-screen size (28px in a 44px tap target) however
     * far the mockup is scaled down, and a tap on one becomes a `pin-open`.
     * Without it markers keep their layout size and ignore the pointer.
     */
    scale: z.number().finite().min(0.01).max(8).optional(),
  }),
]);
export type ViewerMessage = z.infer<typeof viewerMessageSchema>;

/** Mockup → viewer. */
export const mockupMessageSchema = z.discriminatedUnion('type', [
  /** The helper is listening; the viewer sends theme, pin mode and pins. */
  z.strictObject({
    source: z.literal(MOCKUP_MESSAGE_SOURCE),
    type: z.literal('ready'),
  }),
  /**
   * A click in pin mode: `x`/`y` relative to the document (page
   * coordinates), and the CSS path of the element under it. `clientX` /
   * `clientY` are the same click in the frame's viewport: the viewer cannot
   * read the mockup's scroll offset (opaque origin), so it anchors the
   * comment box with these. Optional, so a helper served before they existed
   * still parses; the viewer then opens the box beside the frame.
   */
  z.strictObject({
    source: z.literal(MOCKUP_MESSAGE_SOURCE),
    type: z.literal('pin'),
    x: coordinate,
    y: coordinate,
    clientX: coordinate.optional(),
    clientY: coordinate.optional(),
    selector: z.string().min(1).max(DESIGN_SELECTOR_MAX),
  }),
  /** A tap on an existing marker (touch only): the viewer shows its comment. */
  z.strictObject({
    source: z.literal(MOCKUP_MESSAGE_SOURCE),
    type: z.literal('pin-open'),
    n: z.number().int().min(1).max(10_000),
  }),
  /**
   * Ctrl/⌘ + wheel over the mockup: wheel events never leave the frame, so
   * the helper forwards the travel and the viewer zooms. A plain wheel is
   * not sent — the mockup scrolls itself.
   */
  z.strictObject({
    source: z.literal(MOCKUP_MESSAGE_SOURCE),
    type: z.literal('wheel'),
    deltaY: z.number().finite().min(-1_000_000).max(1_000_000),
  }),
]);
export type MockupMessage = z.infer<typeof mockupMessageSchema>;

/**
 * The helper's source. Plain ES2017 in one IIFE; it touches the document
 * only to draw markers inside its own layer.
 */
export const MOCKUP_PIN_HELPER_SCRIPT = `(function () {
  var FROM = ${JSON.stringify(VIEWER_MESSAGE_SOURCE)};
  var TO = ${JSON.stringify(MOCKUP_MESSAGE_SOURCE)};
  var MAX = ${DESIGN_SELECTOR_MAX};
  var pinMode = false;
  var layer = null;
  function send(msg) { msg.source = TO; window.parent.postMessage(msg, '*'); }
  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var tag = el.tagName.toLowerCase();
      var i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(tag + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    var path = parts.join(' > ') || 'html';
    return path.length > MAX ? path.slice(path.length - MAX) : path;
  }
  function drawPins(pins, scale) {
    if (layer) layer.remove();
    layer = document.createElement('div');
    layer.setAttribute('data-agentdock-pins', '');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    pins.forEach(function (p) {
      var m = document.createElement('div');
      m.textContent = String(p.n);
      if (scale > 0) {
        var hit = 44 / scale, dot = 28 / scale;
        m.style.cssText = 'position:absolute;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;width:' + hit + 'px;height:' + hit + 'px';
        var d = document.createElement('div');
        d.textContent = String(p.n);
        d.style.cssText = 'min-width:' + dot + 'px;height:' + dot + 'px;padding:0 ' + 6 / scale + 'px;box-sizing:border-box;border-radius:' + dot / 2 + 'px;background:#e5484d;color:#fff;font:600 ' + 14 / scale + 'px/' + dot + 'px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 ' + 2 / scale + 'px #fff';
        m.textContent = '';
        m.appendChild(d);
        m.setAttribute('data-pin', String(p.n));
      } else {
        m.style.cssText = 'position:absolute;transform:translate(-50%,-50%);min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#e5484d;color:#fff;font:600 12px/22px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff';
      }
      m.style.left = p.x + 'px';
      m.style.top = p.y + 'px';
      layer.appendChild(m);
    });
    document.body.appendChild(layer);
  }
  document.addEventListener('click', function (e) {
    var tapped = e.target && e.target.closest ? e.target.closest('[data-pin]') : null;
    if (tapped) {
      e.preventDefault();
      e.stopPropagation();
      send({ type: 'pin-open', n: Number(tapped.getAttribute('data-pin')) });
      return;
    }
    if (!pinMode) return;
    e.preventDefault();
    e.stopPropagation();
    var target = e.target && e.target.nodeType === 1 ? e.target : document.body;
    send({ type: 'pin', x: Math.max(0, e.pageX), y: Math.max(0, e.pageY), clientX: Math.max(0, e.clientX), clientY: Math.max(0, e.clientY), selector: cssPath(target) });
  }, true);
  document.addEventListener('wheel', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    send({ type: 'wheel', deltaY: e.deltaY });
  }, { passive: false });
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.source !== FROM) return;
    if (d.type === 'theme' && (d.theme === 'light' || d.theme === 'dark')) {
      document.documentElement.setAttribute('data-theme', d.theme);
    } else if (d.type === 'pin-mode') {
      pinMode = d.on === true;
      document.documentElement.style.cursor = pinMode ? 'crosshair' : '';
    } else if (d.type === 'pins' && Array.isArray(d.pins)) {
      drawPins(d.pins, typeof d.scale === 'number' ? d.scale : 0);
    }
  });
  send({ type: 'ready' });
})();`;

/** The marker the helper's `<script>` carries, so a publish can tell it apart. */
export const MOCKUP_PIN_HELPER_ATTRIBUTE = 'data-agentdock-pin-helper';

/**
 * The mockup as the endpoint serves it: the helper before the last
 * `</body>`, or at the end of a document without one.
 */
export const injectPinHelper = (html: string): string => {
  const tag = `<script ${MOCKUP_PIN_HELPER_ATTRIBUTE}>${MOCKUP_PIN_HELPER_SCRIPT}</script>`;
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at === -1
    ? `${html}${tag}`
    : `${html.slice(0, at)}${tag}${html.slice(at)}`;
};
