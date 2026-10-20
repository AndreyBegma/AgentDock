import {
  DESIGN_VIEWPORTS_MAX,
  type DesignTheme,
  type ViewportPreset,
  viewportPresetSchema,
} from '@nautelle/shared';

/**
 * The viewport presets editor (spec 223 D11, Settings → Design). Rows are
 * kept as typed text so a half-typed width is not lost; `readViewportRows`
 * turns them into presets or says, per row, what is wrong.
 */
export interface ViewportRow {
  /** Stable React key; not saved. */
  key: string;
  name: string;
  width: string;
  height: string;
  /** Empty: the viewer offers both themes. */
  theme: DesignTheme | '';
}

let rowSeq = 0;
const nextKey = (): string => {
  rowSeq += 1;
  return `vp-${rowSeq}`;
};

export const toRows = (presets: readonly ViewportPreset[]): ViewportRow[] =>
  presets.map((p) => ({
    key: nextKey(),
    name: p.name,
    width: String(p.width),
    height: String(p.height),
    theme: p.theme ?? '',
  }));

export const blankRow = (): ViewportRow => ({
  key: nextKey(),
  name: '',
  width: '1280',
  height: '800',
  theme: '',
});

export const canAddRow = (rows: readonly ViewportRow[]): boolean =>
  rows.length < DESIGN_VIEWPORTS_MAX;

/** Moves row `from` by `delta` places, clamped to the list. */
export function moveRow(
  rows: readonly ViewportRow[],
  from: number,
  delta: number,
): ViewportRow[] {
  const to = Math.min(rows.length - 1, Math.max(0, from + delta));
  if (to === from) return [...rows];
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export type ViewportRowsResult =
  | { ok: true; presets: ViewportPreset[] }
  | { ok: false; errors: Record<string, string>; listError: string | null };

const toInt = (text: string): number =>
  /^\s*\d+\s*$/.test(text) ? Number(text) : Number.NaN;

/** The presets to save, or the first problem of each row and of the list. */
export function readViewportRows(
  rows: readonly ViewportRow[],
): ViewportRowsResult {
  const errors: Record<string, string> = {};
  const presets: ViewportPreset[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const candidate = {
      name: row.name.trim(),
      width: toInt(row.width),
      height: toInt(row.height),
      ...(row.theme ? { theme: row.theme } : {}),
    };
    const parsed = viewportPresetSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = String(issue?.path[0] ?? 'name');
      errors[row.key] =
        field === 'name'
          ? 'Give the preset a name.'
          : `${field === 'width' ? 'Width' : 'Height'} must be a whole number of pixels within the allowed range.`;
      continue;
    }
    if (seen.has(parsed.data.name)) {
      errors[row.key] = 'Another preset has this name.';
      continue;
    }
    seen.add(parsed.data.name);
    presets.push(parsed.data);
  }

  const listError =
    rows.length === 0
      ? 'Keep at least one preset.'
      : rows.length > DESIGN_VIEWPORTS_MAX
        ? `At most ${DESIGN_VIEWPORTS_MAX} presets.`
        : null;
  if (Object.keys(errors).length > 0 || listError) {
    return { ok: false, errors, listError };
  }
  return { ok: true, presets };
}
