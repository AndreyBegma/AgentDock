import type { DesignUserRef } from './contracts';
import type { DesignTemplate, DesignTemplateFrame } from './templates';

/**
 * #833 D9: a project's design templates as the API serves them — a built-in
 * with the project's override merged in, or the project's own.
 */
export interface DesignTemplateView extends DesignTemplate {
  /** True for `page`, `component` and `flow`. */
  builtin: boolean;
  /** A built-in with a stored override; always true for a custom template. */
  overridden: boolean;
  updatedBy: DesignUserRef | null;
  updatedAt: string | null;
}

/**
 * D9: what an override of built-in `builtin` may not do. Empty when `next`
 * is a legal override: every built-in frame it keeps keeps its kind, name,
 * requirement and `repeat.min`; a required one is never dropped; a frame of
 * a built-in kind is a built-in frame, any other is `custom`.
 */
export const builtinOverrideProblems = (
  builtin: DesignTemplate,
  next: DesignTemplate,
): string[] => {
  const problems: string[] = [];
  if (next.name !== builtin.name) {
    problems.push(`the name of the built-in ${builtin.key} template is fixed`);
  }
  for (const f of builtin.frames) {
    if (f.required && !next.frames.some((o) => o.key === f.key)) {
      problems.push(`the required frame ${f.key} cannot be removed`);
    }
  }
  for (const f of next.frames) {
    const base = builtin.frames.find((b) => b.key === f.key);
    if (!base) {
      if (f.kind !== 'custom') {
        problems.push(`frame ${f.key} is not a frame of ${builtin.key}`);
      }
      continue;
    }
    if (f.kind !== base.kind) {
      problems.push(`the kind of frame ${f.key} is fixed`);
    }
    if (f.name !== base.name) {
      problems.push(`the name of frame ${f.key} is fixed`);
    }
    if (f.required !== base.required) {
      problems.push(
        `frame ${f.key} cannot become ${f.required ? 'required' : 'optional'}`,
      );
    }
    if (f.repeat?.min !== base.repeat?.min) {
      problems.push(`repeat.min of frame ${f.key} is fixed`);
    }
  }
  return problems;
};

/** `GET /projects/:id/design/templates`: the built-ins, then the custom ones. */
export interface DesignTemplatesView {
  templates: DesignTemplateView[];
}

/**
 * `PUT /projects/:id/design/templates/:key` (project admin): the key is the
 * path's. A built-in key may change only its frames' `enabled`,
 * `instruction`, order, add custom frames and set `repeat.max`.
 */
export interface DesignTemplateUpsertRequest {
  name: string;
  frames: DesignTemplateFrame[];
}
