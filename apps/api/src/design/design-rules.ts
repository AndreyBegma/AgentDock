import type {
  DesignCommentKind,
  DesignSuggestion,
  DesignTheme,
  PlanTaskStatus,
  TaskDesignStatus,
} from '@nautelle/shared';
import { z } from 'zod';

/**
 * The design stage's rules the planner applies (docs/specs/223-design-stage.md
 * D1–D4, D10). Pure: no database, no Nest.
 */

/** What a task's status needs to know of its design. */
export interface DesignGate {
  needed: boolean;
  status: TaskDesignStatus;
}

/** D1: a design that is on and not approved holds the task. */
export const designBlocks = (design: DesignGate | null | undefined): boolean =>
  design?.needed === true && design.status !== 'approved';

/**
 * D1: a task with nothing blocking is `ready`, or `needs_design` while its
 * design holds it. Every other status is the conversation's or the review's.
 */
export const withDesign = (
  status: PlanTaskStatus,
  design: DesignGate | null | undefined,
): PlanTaskStatus => {
  if (status === 'ready' && designBlocks(design)) return 'needs_design';
  if (status === 'needs_design' && !designBlocks(design)) return 'ready';
  return status;
};

/** The planner's suggestion as a new `task_designs` row (D2, D3). */
export interface SuggestedDesign {
  needed: boolean;
  suggested: boolean;
  suggestionWhy: string;
  variantCount: number;
}

/**
 * D2, D3: a suggestion read for a project. A profile with `hasUi: false`
 * turns every suggestion off — the planner is told so, this enforces it.
 */
export const suggestionOf = (
  suggestion: DesignSuggestion,
  hasUi: boolean | null,
): SuggestedDesign => {
  const needed = suggestion.needed && hasUi !== false;
  return {
    needed,
    suggested: needed,
    suggestionWhy: suggestion.why,
    variantCount: suggestion.variants,
  };
};

/**
 * D2: what a later suggestion changes on an existing row. The planner
 * suggests, the person decides: `needed` stays the person's, and the variant
 * count follows the planner only while nothing was drawn.
 */
export const suggestionUpdate = (
  suggestion: SuggestedDesign,
  row: { status: TaskDesignStatus; drawn: boolean },
): {
  suggested: boolean;
  suggestionWhy: string;
  variantCount?: number;
} => ({
  suggested: suggestion.suggested,
  suggestionWhy: suggestion.suggestionWhy,
  ...(row.status === 'idle' && !row.drawn
    ? { variantCount: suggestion.variantCount }
    : {}),
});

/** A comment's anchor as stored (D9): a screen's and a pin's, nothing on a general one. */
export interface CommentAnchor {
  viewport: string | null;
  theme: DesignTheme | null;
  x: number | null;
  y: number | null;
  selector: string | null;
}

/**
 * D9: a `screen` comment names its viewport and theme; a `pin` also its
 * point and the CSS path under it; a `general` one carries none. The anchor
 * to store, or why the request is refused.
 */
export const commentAnchor = (request: {
  kind: DesignCommentKind;
  viewport?: string;
  theme?: DesignTheme;
  x?: number;
  y?: number;
  selector?: string;
}): CommentAnchor | string => {
  const none: CommentAnchor = {
    viewport: null,
    theme: null,
    x: null,
    y: null,
    selector: null,
  };
  if (request.kind === 'general') return none;
  if (!request.viewport || !request.theme) {
    return `A ${request.kind} comment names its viewport and theme`;
  }
  const screen = { ...none, viewport: request.viewport, theme: request.theme };
  if (request.kind === 'screen') return screen;
  if (
    request.x === undefined ||
    request.y === undefined ||
    request.selector === undefined
  ) {
    return 'A pin carries its point and the CSS path under it';
  }
  return { ...screen, x: request.x, y: request.y, selector: request.selector };
};

/** A design's status once no turn of it runs: reviewing with a revision, else idle. */
export const restingStatus = (drawn: boolean): TaskDesignStatus =>
  drawn ? 'reviewing' : 'idle';

/**
 * What a design turn's run carries in `runs.args.design` (D4, D10): the
 * variant it draws, the variants still to draw after it in this batch, the
 * profile it draws from, the comments open when the batch started — the
 * only ones its `addressed` may name — and the build it waited for, if any.
 */
export const designTurnPlanSchema = z.strictObject({
  mode: z.enum(['generate', 'revise']),
  variant: z.number().int().min(1).max(3),
  remaining: z.array(z.number().int().min(1).max(3)).max(2),
  comments: z.array(z.string().min(1).max(64)).max(100),
  profileId: z.string().min(1).nullable(),
  /** #275 D1: the build this batch waited for — its turns are step 2 of 2. */
  profileBuildRunId: z.string().min(1).optional(),
  /**
   * #833 D7: a repair turn — a revise of the variant's latest revision that
   * does not follow its template. `next` is what the rest of the batch
   * draws: the batch's own mode after an automatic repair, `repair` when a
   * person's Complete repairs every variant. A repair is never repaired again.
   */
  repair: z
    .strictObject({ next: z.enum(['generate', 'revise', 'repair']) })
    .optional(),
});
export type DesignTurnPlan = z.infer<typeof designTurnPlanSchema>;

/** The plan of a design turn's run, or null when its args do not hold one. */
export const designTurnPlanOf = (args: unknown): DesignTurnPlan | null => {
  if (!args || typeof args !== 'object' || !('design' in args)) return null;
  const parsed = designTurnPlanSchema.safeParse(args.design);
  return parsed.success ? parsed.data : null;
};

/**
 * The turns of a Generate or a Revise design (D4, D10), as the first turn's
 * plan with the rest in `remaining`; null when there is nothing to draw.
 * Generate draws revision 1 of every variant up to the count that has none
 * yet; Revise draws the next revision of every variant still in play — one
 * with a revision that is not archived.
 */
export const batchOf = (
  mode: DesignTurnPlan['mode'],
  variantCount: number,
  revisions: readonly { variant: number; archived: boolean }[],
  comments: readonly string[],
  profileId: string | null,
): DesignTurnPlan | null => {
  const drawn = new Set(revisions.map((r) => r.variant));
  const variants =
    mode === 'generate'
      ? Array.from({ length: variantCount }, (_, i) => i + 1).filter(
          (v) => !drawn.has(v),
        )
      : [
          ...new Set(
            revisions.filter((r) => !r.archived).map((r) => r.variant),
          ),
        ].sort((a, b) => a - b);
  const [variant, ...remaining] = variants;
  if (variant === undefined) return null;
  return {
    mode,
    variant,
    remaining,
    comments: mode === 'revise' ? [...comments] : [],
    profileId,
  };
};

/**
 * The next turn of a batch, after `plan`'s variant is drawn. #833: after an
 * automatic repair the batch goes on in its own mode.
 */
export const nextOfBatch = (plan: DesignTurnPlan): DesignTurnPlan | null => {
  const [variant, ...remaining] = plan.remaining;
  if (variant === undefined) return null;
  const { repair, ...rest } = plan;
  if (!repair || repair.next === 'repair') {
    return { ...plan, variant, remaining };
  }
  return { ...rest, mode: repair.next, variant, remaining };
};

/**
 * #833 D7: the one automatic repair of the revision `plan` just drew — a
 * revise of the same variant that carries the rest of the batch.
 */
export const repairOf = (plan: DesignTurnPlan): DesignTurnPlan => ({
  ...plan,
  mode: 'revise',
  repair: { next: plan.mode },
});

/** #833 D7: a person's Complete — a repair of every listed variant. */
export const completeBatchOf = (
  variants: readonly number[],
  profileId: string | null,
): DesignTurnPlan | null => {
  const [variant, ...remaining] = [...variants].sort((a, b) => a - b);
  if (variant === undefined) return null;
  return {
    mode: 'revise',
    variant,
    remaining,
    comments: [],
    profileId,
    repair: { next: 'repair' },
  };
};
