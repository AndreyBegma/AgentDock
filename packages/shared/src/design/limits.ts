/**
 * Limits of the design stage (docs/specs/223-design-stage.md
 * "Configuration", D4, D7, D12, D13, "Open questions").
 */

/**
 * D7: HTML per variant. A turn's whole result travels in one event of at
 * most 192 KiB (`PLAN_TURN_RESULT_MAX_BYTES`), with the plan block beside it.
 */
export const DESIGN_HTML_MAX_BYTES = 160 * 1024;

/** D4: variants per task. */
export const DESIGN_VARIANTS_MIN = 1;
export const DESIGN_VARIANTS_MAX = 3;

/** "Open questions": a kit over this fails the build, asking for a smaller kit. */
export const UI_PROFILE_KIT_MAX_BYTES = 64 * 1024;
/** Characters of a profile's summary markdown. */
export const UI_PROFILE_SUMMARY_MAX = 32_000;
/** Snippets per profile, and bytes of one snippet's HTML. */
export const UI_PROFILE_SNIPPETS_MAX = 40;
export const UI_PROFILE_SNIPPET_MAX_BYTES = 16 * 1024;
export const UI_PROFILE_SNIPPET_NAME_MAX = 64;

/** `uiprofile.fingerprint` (spec "Protocol"). */
export const UIPROFILE_FINGERPRINT_MAX_GLOBS = 64;
export const UIPROFILE_FINGERPRINT_MAX_FILES = 2000;
export const UIPROFILE_GLOB_MAX = 256;

/** "Configuration": a profile build's timeout is 20 min. */
export const UIPROFILE_BUILD_TIMEOUT_SEC = 1200;

/** A design revision's title and rationale (contract v2). */
export const DESIGN_TITLE_MAX = 200;
export const DESIGN_RATIONALE_MAX = 4000;

/** A comment's body (D9), and its anchor. */
export const DESIGN_COMMENT_MAX = 4000;
export const DESIGN_SELECTOR_MAX = 1000;
/** Open comments one revise turn carries; the prompt stays under its byte cap. */
export const DESIGN_COMMENTS_PER_TURN_MAX = 100;

/** D11: viewport presets per project, and their bounds in CSS pixels. */
export const DESIGN_VIEWPORTS_MAX = 12;
export const DESIGN_VIEWPORT_NAME_MAX = 40;
export const DESIGN_VIEWPORT_MIN_PX = 240;
export const DESIGN_VIEWPORT_MAX_PX = 7680;

/** D15: design skills per project default or per design. */
export const DESIGN_SKILLS_MAX = 12;

/** UTF-8 size, the unit every byte limit above is in. */
export const designBytes = (text: string): number =>
  new TextEncoder().encode(text).length;
