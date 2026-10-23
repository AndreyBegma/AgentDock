import { z } from 'zod';
import { DESIGN_FRAME_NAME_MAX, DESIGN_FRAMES_MAX } from './frames';

/**
 * #833 (ADR-0082): a design follows a frame template — an ordered list of
 * typed frames, each required or optional, one of them perhaps repeated (a
 * flow's steps). The three built-in templates live here; a project overrides
 * them or adds its own in `design_templates`. Pure and framework-free: the API
 * resolves a design's template, checks every new revision against it and
 * prompts the turn with it.
 */

/**
 * Every kind a frame can have; `legacy` is a frame stored before #833.
 * `mobile` is no built-in frame since #863 (ADR-0084): every frame is one
 * responsive page drawn for the design's devices. It stays so revisions and
 * project templates stored with it still parse.
 */
export const DESIGN_FRAME_KINDS = [
  'screen',
  'breakdown',
  'states',
  'in_context',
  'anatomy',
  'state_grid',
  'flow_map',
  'flow_step',
  'mobile',
  'custom',
  'legacy',
] as const;
export type DesignFrameKind = (typeof DESIGN_FRAME_KINDS)[number];
export const designFrameKindSchema = z.enum(DESIGN_FRAME_KINDS);

/** The viewer's label of each kind (D11). */
export const DESIGN_FRAME_KIND_LABELS: Record<DesignFrameKind, string> = {
  screen: 'Screen',
  breakdown: 'Breakdown',
  states: 'States',
  in_context: 'In context',
  anatomy: 'Anatomy',
  state_grid: 'State grid',
  flow_map: 'Flow map',
  flow_step: 'Step',
  mobile: 'Mobile',
  custom: 'Custom',
  legacy: 'Frame',
};

/** D4: the frames that explain rather than show — drawn in the project's kit all the same. */
export const DESIGN_SERVICE_FRAME_KINDS: readonly DesignFrameKind[] = [
  'breakdown',
  'anatomy',
  'state_grid',
  'flow_map',
];

/** D8: who chose a design's template — the model, or a person. */
export const DESIGN_TEMPLATE_CHOICES = ['auto', 'person'] as const;
export type DesignTemplateChoice = (typeof DESIGN_TEMPLATE_CHOICES)[number];

/** The template a design without a choice follows. */
export const DEFAULT_DESIGN_TEMPLATE_KEY = 'page';

/** A template's key: a built-in's, or a project's own (`landing`). */
export const DESIGN_TEMPLATE_KEY_MAX = 40;
export const DESIGN_TEMPLATE_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;
export const DESIGN_TEMPLATE_NAME_MAX = 80;
/** What one frame's instruction may say. */
export const DESIGN_TEMPLATE_INSTRUCTION_MAX = 1000;
/** Frames of one template, a repeated one counted once. */
export const DESIGN_TEMPLATE_FRAMES_MAX = 16;
/** D12: a flow's steps by default, and the most a template may allow. */
export const DESIGN_FLOW_STEPS_DEFAULT = 6;
export const DESIGN_FLOW_STEPS_MAX = 12;

export interface DesignTemplateFrame {
  /** Unique within the template; a built-in frame's key is its kind. */
  key: string;
  kind: DesignFrameKind;
  /** The tab label, at most `DESIGN_FRAME_NAME_MAX`. */
  name: string;
  /** What to draw, at most `DESIGN_TEMPLATE_INSTRUCTION_MAX`. */
  instruction: string;
  required: boolean;
  /** Only an optional frame can be disabled. */
  enabled: boolean;
  /** `flow_step` only: how many times the frame appears. */
  repeat?: { min: number; max: number };
}

export interface DesignTemplate {
  key: string;
  name: string;
  frames: DesignTemplateFrame[];
}

/**
 * The stored `design_revisions.conformance` (D7, D12): the template keys of
 * the frames missing or out of place, the names of the frames the template
 * has no slot for, and why the revision cannot conform as asked.
 */
export interface DesignConformance {
  ok: boolean;
  missing: string[];
  extra: string[];
  misplaced: string[];
  reason?: 'too_many_steps';
}

export const designConformanceSchema = z.object({
  ok: z.boolean(),
  missing: z.array(z.string()),
  extra: z.array(z.string()),
  misplaced: z.array(z.string()),
  reason: z.literal('too_many_steps').optional(),
});

const frame = (
  kind: Exclude<DesignFrameKind, 'custom' | 'legacy'>,
  name: string,
  instruction: string,
  required = true,
  repeat?: { min: number; max: number },
): DesignTemplateFrame => ({
  key: kind,
  kind,
  name,
  instruction,
  required,
  enabled: true,
  ...(repeat ? { repeat } : {}),
});

/** D1: the three built-in templates, in the order the card's select lists them. */
export const BUILTIN_DESIGN_TEMPLATES: readonly DesignTemplate[] = [
  {
    key: 'page',
    name: 'Page',
    frames: [
      frame(
        'screen',
        'Screen',
        'The finished page, with realistic content and no explanatory text.',
      ),
      frame(
        'breakdown',
        'Breakdown',
        'The screen again with numbered zones and a legend: what is new or changed, which components it uses, how it behaves, and why.',
      ),
      frame(
        'states',
        'States',
        'The empty, loading and error states.',
        false,
      ),
    ],
  },
  {
    key: 'component',
    name: 'Component',
    frames: [
      frame(
        'in_context',
        'In context',
        'The component on a realistic sample page.',
      ),
      frame(
        'anatomy',
        'Anatomy and props',
        'The component with numbered parts, a props table, and its spacing labelled with token names.',
      ),
      frame(
        'state_grid',
        'Variants × states',
        'A grid: rows are sizes or kinds; columns are default, hover, focus, active, disabled, loading and error. A cell that does not apply reads "n/a" and is never dropped.',
      ),
    ],
  },
  {
    key: 'flow',
    name: 'Flow',
    frames: [
      frame(
        'flow_map',
        'Flow map',
        'A thumbnail of every step, with arrows and the branches (error, back, skip).',
      ),
      frame(
        'flow_step',
        'Step',
        'One step of the flow as a full screen.',
        true,
        {
          min: 1,
          max: DESIGN_FLOW_STEPS_DEFAULT,
        },
      ),
      frame(
        'breakdown',
        'Breakdown',
        'The components, states and logic the steps share.',
      ),
    ],
  },
];

/** The built-in template of `key`, if it is one. */
export const builtinDesignTemplate = (
  key: string,
): DesignTemplate | undefined =>
  BUILTIN_DESIGN_TEMPLATES.find((t) => t.key === key);

const lower = (s: string) => s.toLowerCase();

const templateFrameSchema = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(DESIGN_TEMPLATE_KEY_MAX)
    .regex(DESIGN_TEMPLATE_KEY_PATTERN),
  kind: designFrameKindSchema.exclude(['legacy']),
  name: z
    .string()
    .trim()
    .min(1)
    .max(DESIGN_FRAME_NAME_MAX)
    .regex(/^[^\r\n]*$/, 'a frame name is one line'),
  instruction: z.string().trim().min(1).max(DESIGN_TEMPLATE_INSTRUCTION_MAX),
  required: z.boolean(),
  enabled: z.boolean(),
  repeat: z
    .strictObject({
      min: z.number().int().min(1).max(DESIGN_FLOW_STEPS_MAX),
      max: z.number().int().min(1).max(DESIGN_FLOW_STEPS_MAX),
    })
    .refine((r) => r.min <= r.max, 'repeat.min is above repeat.max')
    .optional(),
});

/**
 * D9: a template as a project stores it — a built-in's override or its own.
 * Keys and names are unique, a kind other than `custom` appears once, only a
 * `flow_step` repeats, and a required frame is always enabled.
 */
export const designTemplateSchema = z
  .strictObject({
    key: z
      .string()
      .min(1)
      .max(DESIGN_TEMPLATE_KEY_MAX)
      .regex(DESIGN_TEMPLATE_KEY_PATTERN),
    name: z.string().trim().min(1).max(DESIGN_TEMPLATE_NAME_MAX),
    frames: z.array(templateFrameSchema).min(1).max(DESIGN_TEMPLATE_FRAMES_MAX),
  })
  .superRefine((t, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    const keys = new Set<string>();
    const names = new Set<string>();
    const kinds = new Set<string>();
    let size = 0;
    t.frames.forEach((f, i) => {
      if (keys.has(f.key)) issue(`key ${f.key} is used twice`, ['frames', i]);
      keys.add(f.key);
      if (names.has(lower(f.name))) {
        issue(`name ${f.name} is used twice`, ['frames', i]);
      }
      names.add(lower(f.name));
      if (f.kind !== 'custom') {
        if (kinds.has(f.kind)) {
          issue(`kind ${f.kind} is used twice`, ['frames', i]);
        }
        kinds.add(f.kind);
      }
      if (f.repeat && f.kind !== 'flow_step') {
        issue('only a flow_step frame repeats', ['frames', i, 'repeat']);
      }
      if (f.required && !f.enabled) {
        issue('a required frame cannot be disabled', ['frames', i, 'enabled']);
      }
      size += f.repeat?.max ?? 1;
    });
    if (size > DESIGN_FRAMES_MAX) {
      issue(`a template draws at most ${DESIGN_FRAMES_MAX} frames`, ['frames']);
    }
  });

/**
 * D9: the template in effect — a project's override of a built-in, or the
 * built-in, or the project's own template. A required built-in frame the
 * override lacks is put back at its built-in position: the override may
 * change it, never remove it. Null when neither exists.
 */
export const resolveDesignTemplate = (
  builtin: DesignTemplate | null | undefined,
  override?: DesignTemplate | null,
): DesignTemplate | null => {
  if (!override) return builtin ?? null;
  if (!builtin) return override;
  const frames = [...override.frames];
  builtin.frames.forEach((f, i) => {
    if (!f.required || frames.some((o) => o.key === f.key)) return;
    frames.splice(Math.min(i, frames.length), 0, f);
  });
  return {
    key: builtin.key,
    name: override.name,
    frames: frames.map((f) => {
      const base = builtin.frames.find((b) => b.key === f.key);
      return base?.required ? { ...f, required: true, enabled: true } : f;
    }),
  };
};

/** A frame as the check reads it: its name and kind. */
export interface DesignFrameShape {
  name: string;
  kind: DesignFrameKind;
}

/** The enabled frame of `template` a drawn frame fills, by index; -1 for none. */
const slotOf = (
  slots: readonly DesignTemplateFrame[],
  f: DesignFrameShape,
): number =>
  f.kind === 'legacy'
    ? -1
    : f.kind === 'custom'
      ? slots.findIndex(
          (s) => s.kind === 'custom' && lower(s.name) === lower(f.name.trim()),
        )
      : slots.findIndex((s) => s.kind === f.kind);

/**
 * The slot of every frame in order — a non-repeated slot filled once, a
 * second fill reads as no slot — and how many frames fill each slot.
 */
const assign = (
  slots: readonly DesignTemplateFrame[],
  frames: readonly DesignFrameShape[],
): { slot: number[]; count: number[] } => {
  const count = slots.map(() => 0);
  const slot = frames.map((f) => {
    const i = slotOf(slots, f);
    if (i < 0 || (count[i] > 0 && !slots[i].repeat)) return -1;
    count[i] += 1;
    return i;
  });
  return { slot, count };
};

/** Indices of `seq` on one longest non-decreasing subsequence. */
const longestOrdered = (seq: readonly number[]): Set<number> => {
  // Patience sorting: `tails[k]` ends the best run of length k + 1.
  const tails: number[] = [];
  const prev = seq.map(() => -1);
  seq.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] <= v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const kept = new Set<number>();
  for (let i = tails[tails.length - 1] ?? -1; i >= 0; i = prev[i]) kept.add(i);
  return kept;
};

export interface DesignConformanceResult extends DesignConformance {
  /**
   * Per frame, in order: the key of the template frame it fills — a step's
   * with its number (`flow_step-2`) — or null for a frame with no slot.
   */
  templateFrameKeys: (string | null)[];
}

const dedupe = (items: readonly string[]): string[] => [...new Set(items)];

/**
 * D7, D12: how a revision's frames follow its template. Every required
 * enabled frame must appear, in the template's order; a frame the template
 * has no enabled slot for — a disabled one, a second of a kind, a `legacy`
 * one — is extra; a step over `repeat.max` marks the revision
 * `too_many_steps`. Only the frames off the longest ordered run count as
 * misplaced.
 */
export const checkConformance = (
  template: DesignTemplate,
  frames: readonly DesignFrameShape[],
): DesignConformanceResult => {
  const slots = template.frames.filter((f) => f.enabled);
  const { slot, count } = assign(slots, frames);
  const missing = slots
    .filter((s, i) =>
      s.repeat ? count[i] < s.repeat.min : s.required && count[i] === 0,
    )
    .map((s) => s.key);
  const extra = frames.filter((_, i) => slot[i] < 0).map((f) => f.name);
  const placed = frames.flatMap((_, i) => (slot[i] < 0 ? [] : [i]));
  const ordered = longestOrdered(placed.map((i) => slot[i]));
  const misplaced = placed
    .filter((_, k) => !ordered.has(k))
    .map((i) => slots[slot[i]].key);
  const tooMany = slots.some((s, i) => s.repeat && count[i] > s.repeat.max);
  const seen = slots.map(() => 0);
  const templateFrameKeys = slot.map((i) => {
    if (i < 0) return null;
    seen[i] += 1;
    return slots[i].repeat ? `${slots[i].key}-${seen[i]}` : slots[i].key;
  });
  const result: DesignConformanceResult = {
    ok:
      missing.length === 0 &&
      extra.length === 0 &&
      misplaced.length === 0 &&
      !tooMany,
    missing,
    extra: dedupe(extra),
    misplaced: dedupe(misplaced),
    templateFrameKeys,
  };
  if (tooMany) result.reason = 'too_many_steps';
  return result;
};

/** The stored conformance of a check: without the per-frame keys. */
export const conformanceOf = ({
  templateFrameKeys: _,
  ...stored
}: DesignConformanceResult): DesignConformance => stored;

/**
 * D10, ADR-0062: a revise draws only what it changes, but it never drops a
 * required frame — every required slot the answer leaves empty is filled
 * with the previous revision's frames of that slot, each put before the
 * first frame of a later slot.
 */
export const carryRequiredFrames = <F extends DesignFrameShape>(
  template: DesignTemplate,
  frames: readonly F[],
  previous: readonly F[],
): F[] => {
  const slots = template.frames.filter((f) => f.enabled);
  const result = [...frames];
  const before = assign(slots, previous).slot;
  slots.forEach((s, i) => {
    if (!s.required) return;
    if (assign(slots, result).count[i] > 0) return;
    const carried = previous.filter((_, k) => before[k] === i);
    if (carried.length === 0) return;
    const now = assign(slots, result).slot;
    const at = now.findIndex((j) => j > i);
    result.splice(at < 0 ? result.length : at, 0, ...carried);
  });
  return result;
};
