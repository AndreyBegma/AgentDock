import {
  BUILTIN_DESIGN_TEMPLATES,
  DESIGN_FRAME_KIND_LABELS,
  type DesignConformance,
  type DesignFrameView,
  type DesignRevisionView,
  type DesignTemplate,
  type DesignTemplatesView,
} from '@nautelle/shared';

/** D11: the tab's kind label; a legacy frame (stored before templates) has none. */
export function frameKindLabel(
  frame: Pick<DesignFrameView, 'kind'>,
): string | null {
  return frame.kind === 'legacy' ? null : DESIGN_FRAME_KIND_LABELS[frame.kind];
}

export interface ConformanceLine {
  label: string;
  items: string[];
}

export interface ConformanceNote {
  lines: ConformanceLine[];
  /** D12: the flow needed more steps than the template allows. */
  tooManySteps: boolean;
}

/**
 * D11: the "Not per template" badge's content. `null` — no badge — for a
 * legacy revision (no conformance) and for a conforming one.
 */
export function conformanceNote(
  conformance: DesignConformance | null,
): ConformanceNote | null {
  if (!conformance || conformance.ok) return null;
  const lines: ConformanceLine[] = [
    { label: 'Missing', items: conformance.missing },
    { label: 'Extra', items: conformance.extra },
    { label: 'Out of order', items: conformance.misplaced },
  ].filter((line) => line.items.length > 0);
  return { lines, tooManySteps: conformance.reason === 'too_many_steps' };
}

export interface CompareColumn {
  variant: number;
  revision: DesignRevisionView;
  /** The frame at the compared position; null when this variant has fewer frames. */
  frame: DesignFrameView | null;
}

/**
 * D11: Compare — the same frame position of every variant's latest revision,
 * in variant order. Variants are the ones in view, so an archived variant is
 * not compared.
 */
export function compareColumns(
  revisions: readonly DesignRevisionView[],
  variants: readonly number[],
  position: number,
): CompareColumn[] {
  return variants.flatMap((variant) => {
    const latest = revisions
      .filter((r) => r.variant === variant)
      .sort((a, b) => b.revision - a.revision)[0];
    return latest
      ? [{ variant, revision: latest, frame: latest.frames[position] ?? null }]
      : [];
  });
}

/** The templates of a loaded response; null while loading or after a failed request. */
export function templatesOf(
  data: DesignTemplatesView | undefined,
): DesignTemplate[] | null {
  return Array.isArray(data?.templates) ? data.templates : null;
}

/** The select's options: the project's templates when they loaded, else the built-ins. */
export function templateOptions(
  loaded: readonly DesignTemplate[] | null | undefined,
): { key: string; name: string }[] {
  const templates = loaded && loaded.length > 0 ? loaded : null;
  return (templates ?? BUILTIN_DESIGN_TEMPLATES).map((t) => ({
    key: t.key,
    name: t.name,
  }));
}
