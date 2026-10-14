import {
  DEFAULT_VIEWPORTS,
  DESIGN_THEMES,
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
  type DesignRevisionView,
  type DesignTheme,
  type ViewportPreset,
} from '@agentdock/shared';

/**
 * The viewer's state (spec 223 D11), all of it in the URL so a link opens
 * the same screen: `?variant=2&rev=<revisionId>&vp=Mobile&theme=dark&w=412`.
 * Anything missing or wrong falls back to a default rather than failing.
 */
export interface ViewerState {
  variant: number;
  /** The revision in view; null while the design has none. */
  revision: DesignRevisionView | null;
  /** The preset in view; its name is `vp`. */
  viewport: ViewportPreset;
  theme: DesignTheme;
  /** The frame's width: `w`, else the preset's. */
  width: number;
  /** True when `w` differs from the preset's width. */
  customWidth: boolean;
}

/** The URL keys, so a link and the parser agree. */
export const VIEWER_PARAM = {
  variant: 'variant',
  revision: 'rev',
  viewport: 'vp',
  theme: 'theme',
  width: 'w',
} as const;

export const clampWidth = (width: number): number =>
  Math.min(
    DESIGN_VIEWPORT_MAX_PX,
    Math.max(DESIGN_VIEWPORT_MIN_PX, Math.round(width)),
  );

const isTheme = (value: string | null): value is DesignTheme =>
  value !== null && (DESIGN_THEMES as readonly string[]).includes(value);

/**
 * The variants still in play, ascending: those with a revision that is not
 * archived (D4 archives the ones not picked). A design whose every revision
 * is archived — none should be — shows them all rather than nothing.
 */
export function variantsOf(revisions: readonly DesignRevisionView[]): number[] {
  const live = revisions.filter((r) => !r.archived);
  const from = live.length > 0 ? live : revisions;
  return [...new Set(from.map((r) => r.variant))].sort((a, b) => a - b);
}

/** One variant's revisions, newest first. */
export const revisionsOf = (
  revisions: readonly DesignRevisionView[],
  variant: number,
): DesignRevisionView[] =>
  revisions
    .filter((r) => r.variant === variant)
    .sort((a, b) => b.revision - a.revision);

const positiveInt = (raw: string | null): number | null => {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function resolveViewerState(
  params: URLSearchParams,
  revisions: readonly DesignRevisionView[],
  viewports: readonly ViewportPreset[],
): ViewerState {
  const presets = viewports.length > 0 ? viewports : DEFAULT_VIEWPORTS;
  const variants = variantsOf(revisions);

  // A revision named in the URL wins: it also fixes the variant.
  const named = revisions.find(
    (r) => r.id === params.get(VIEWER_PARAM.revision),
  );
  const asked = positiveInt(params.get(VIEWER_PARAM.variant));
  const variant =
    named?.variant ??
    (asked !== null && variants.includes(asked) ? asked : variants[0]) ??
    1;
  const revision = named ?? revisionsOf(revisions, variant)[0] ?? null;

  const viewport =
    presets.find((p) => p.name === params.get(VIEWER_PARAM.viewport)) ??
    presets[0];
  const themeParam = params.get(VIEWER_PARAM.theme);
  const theme = isTheme(themeParam) ? themeParam : (viewport.theme ?? 'light');

  const w = positiveInt(params.get(VIEWER_PARAM.width));
  const width = w === null ? viewport.width : clampWidth(w);

  return {
    variant,
    revision,
    viewport,
    theme,
    width,
    customWidth: width !== viewport.width,
  };
}

/** A change to the state, as the URL keys it touches. */
export type ViewerChange =
  | { kind: 'variant'; variant: number }
  | { kind: 'revision'; revisionId: string }
  | { kind: 'viewport'; viewport: ViewportPreset }
  | { kind: 'theme'; theme: DesignTheme }
  | { kind: 'width'; width: number };

/**
 * The next query string. Choosing a variant or a preset drops what it
 * replaces: a variant shows its latest revision, a preset its own width and
 * theme.
 */
export function applyViewerChange(
  params: URLSearchParams,
  change: ViewerChange,
): string {
  const next = new URLSearchParams(params);
  switch (change.kind) {
    case 'variant':
      next.set(VIEWER_PARAM.variant, String(change.variant));
      next.delete(VIEWER_PARAM.revision);
      break;
    case 'revision':
      next.set(VIEWER_PARAM.revision, change.revisionId);
      next.delete(VIEWER_PARAM.variant);
      break;
    case 'viewport':
      next.set(VIEWER_PARAM.viewport, change.viewport.name);
      next.delete(VIEWER_PARAM.width);
      if (change.viewport.theme) {
        next.set(VIEWER_PARAM.theme, change.viewport.theme);
      }
      break;
    case 'theme':
      next.set(VIEWER_PARAM.theme, change.theme);
      break;
    case 'width':
      next.set(VIEWER_PARAM.width, String(clampWidth(change.width)));
      break;
  }
  const query = next.toString();
  return query ? `?${query}` : '';
}
