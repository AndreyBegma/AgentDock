import { z } from 'zod';
import {
  DESIGN_VARIANTS_MAX,
  DESIGN_VARIANTS_MIN,
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
  DESIGN_VIEWPORT_NAME_MAX,
  DESIGN_VIEWPORTS_MAX,
  designBytes,
  UI_PROFILE_RULE_COMMENTS_MAX,
  UI_PROFILE_SCREEN_NAME_MAX,
  UI_PROFILE_SCREEN_SUMMARY_MAX,
  UI_PROFILE_SCREENS_MAX,
  UI_PROFILE_SNIPPET_MAX_BYTES,
  UI_PROFILE_SNIPPET_NAME_MAX,
  UI_PROFILE_SNIPPETS_MAX,
  UI_PROFILE_STYLE_RULE_MAX,
  UI_PROFILE_STYLE_RULES_MAX,
  UIPROFILE_GLOB_MAX,
} from './limits';
import { DESIGN_TEMPLATE_KEY_MAX } from './templates';

/**
 * The design stage's types (docs/specs/223-design-stage.md): UI profile,
 * style kit, design, revision, comment and settings. Every list below has a
 * Prisma enum or column of the same values (spec "Data / Schema").
 */

// Themes and viewports (D11)

export const DESIGN_THEMES = ['light', 'dark'] as const;
export const designThemeSchema = z.enum(DESIGN_THEMES);
export type DesignTheme = z.infer<typeof designThemeSchema>;

/**
 * A viewport preset. Without `theme`, the viewer offers both; with one, the
 * preset opens in it.
 */
export const viewportPresetSchema = z.strictObject({
  name: z.string().trim().min(1).max(DESIGN_VIEWPORT_NAME_MAX),
  width: z
    .number()
    .int()
    .min(DESIGN_VIEWPORT_MIN_PX)
    .max(DESIGN_VIEWPORT_MAX_PX),
  height: z
    .number()
    .int()
    .min(DESIGN_VIEWPORT_MIN_PX)
    .max(DESIGN_VIEWPORT_MAX_PX),
  theme: designThemeSchema.optional(),
});
export type ViewportPreset = z.infer<typeof viewportPresetSchema>;

export const viewportPresetsSchema = z
  .array(viewportPresetSchema)
  .min(1)
  .max(DESIGN_VIEWPORTS_MAX)
  .refine((vs) => new Set(vs.map((v) => v.name)).size === vs.length, {
    message: 'viewport names must be unique',
  });

/**
 * D11, #863 (ADR-0084): the built-in devices — what a project without a
 * `design_settings` row offers, and what a Generate without devices draws
 * for. The viewer offers light and dark on each when the profile reports a
 * dark theme.
 */
export const DEFAULT_VIEWPORTS: readonly ViewportPreset[] = [
  { name: 'Desktop', width: 1440, height: 900 },
  { name: 'Tablet', width: 834, height: 1194 },
  { name: 'Phone', width: 390, height: 844 },
];

// Suggestions and designs (D2, D4)

export const designVariantSchema = z
  .number()
  .int()
  .min(DESIGN_VARIANTS_MIN)
  .max(DESIGN_VARIANTS_MAX);
export type DesignVariant = z.infer<typeof designVariantSchema>;

/** D2: what `decompose` and `grill` say about a task's design (contract v2). */
export const designSuggestionSchema = z.strictObject({
  needed: z.boolean(),
  why: z.string().trim().min(1).max(500),
  variants: designVariantSchema,
  /** #833 D8: the template the planner suggests (a key of the project's); absent keeps `page`. */
  template: z.string().min(1).max(DESIGN_TEMPLATE_KEY_MAX).optional(),
});
export type DesignSuggestion = z.infer<typeof designSuggestionSchema>;

/** `task_designs.status`. */
export const TASK_DESIGN_STATUSES = [
  'idle',
  'generating',
  'reviewing',
  'revising',
  'approved',
] as const;
export const taskDesignStatusSchema = z.enum(TASK_DESIGN_STATUSES);
export type TaskDesignStatus = z.infer<typeof taskDesignStatusSchema>;

/** D9. */
export const DESIGN_COMMENT_KINDS = ['general', 'screen', 'pin'] as const;
export const designCommentKindSchema = z.enum(DESIGN_COMMENT_KINDS);
export type DesignCommentKind = z.infer<typeof designCommentKindSchema>;

// UI profile (D12–D14)

/**
 * D14: `manual` is a person's edit, kept as obligations for the next build.
 * #752 (ADR-0075 §6): `memory` is what an approved design taught, kept the
 * same way.
 */
export const UI_PROFILE_SOURCES = ['agent', 'manual', 'memory'] as const;
export const uiProfileSourceSchema = z.enum(UI_PROFILE_SOURCES);
export type UiProfileSource = z.infer<typeof uiProfileSourceSchema>;

/** Derived on read: no profile, the fingerprint matches, it does not, a build runs. */
export const UI_PROFILE_STATUSES = [
  'none',
  'fresh',
  'stale',
  'building',
] as const;
export const uiProfileStatusSchema = z.enum(UI_PROFILE_STATUSES);
export type UiProfileStatus = z.infer<typeof uiProfileStatusSchema>;

/** One key component's HTML in the style kit: `button`, `input`, `card`, … */
export const uiProfileSnippetSchema = z.strictObject({
  name: z.string().trim().min(1).max(UI_PROFILE_SNIPPET_NAME_MAX),
  html: z
    .string()
    .min(1)
    .refine((h) => designBytes(h) <= UI_PROFILE_SNIPPET_MAX_BYTES, {
      message: `must be at most ${UI_PROFILE_SNIPPET_MAX_BYTES} bytes`,
    }),
});
export type UiProfileSnippet = z.infer<typeof uiProfileSnippetSchema>;

/** #752 A3: one approved screen of the profile's library. */
export const uiProfileScreenSchema = z.strictObject({
  designId: z.string().min(1),
  revisionId: z.string().min(1),
  name: z.string().trim().min(1).max(UI_PROFILE_SCREEN_NAME_MAX),
  summary: z.string().trim().min(1).max(UI_PROFILE_SCREEN_SUMMARY_MAX),
  snippetsUsed: z
    .array(z.string().trim().min(1).max(UI_PROFILE_SNIPPET_NAME_MAX))
    .max(UI_PROFILE_SNIPPETS_MAX),
  approvedAt: z.iso.datetime(),
});
export type UiProfileScreen = z.infer<typeof uiProfileScreenSchema>;

/** #752 A3: one style rule, with the design comments it came from. */
export const uiProfileStyleRuleSchema = z.strictObject({
  text: z.string().trim().min(1).max(UI_PROFILE_STYLE_RULE_MAX),
  commentIds: z.array(z.string().min(1)).max(UI_PROFILE_RULE_COMMENTS_MAX),
  /** The design it was learned from; null for a rule a person wrote. */
  designId: z.string().min(1).nullable(),
});
export type UiProfileStyleRule = z.infer<typeof uiProfileStyleRuleSchema>;

export const uiProfileScreensSchema = z
  .array(uiProfileScreenSchema)
  .max(UI_PROFILE_SCREENS_MAX);
export const uiProfileStyleRulesSchema = z
  .array(uiProfileStyleRuleSchema)
  .max(UI_PROFILE_STYLE_RULES_MAX);

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * A fingerprint glob (spec "Protocol"): repository-relative and confined to
 * the project root — no leading `/`, no drive, no `\`, no `..` segment.
 */
export const fingerprintGlobSchema = z
  .string()
  .trim()
  .min(1)
  .max(UIPROFILE_GLOB_MAX)
  .refine(
    (g) =>
      !g.startsWith('/') &&
      !/^[A-Za-z]:/.test(g) &&
      !g.includes('\\') &&
      !CONTROL_CHARS.test(g) &&
      g.split('/').every((seg) => seg !== '..'),
    {
      message: 'must be repository-relative, without ".." or an absolute path',
    },
  );
