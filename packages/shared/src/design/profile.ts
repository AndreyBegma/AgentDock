import { z } from 'zod';
import { extractPlannerBlocks } from '../planner/contract';
import { PLANNER_BLOCK_TAG } from '../planner/types';
import {
  designBytes,
  UI_PROFILE_KIT_MAX_BYTES,
  UI_PROFILE_SNIPPET_MAX_BYTES,
  UI_PROFILE_SNIPPETS_MAX,
  UI_PROFILE_SUMMARY_MAX,
  UIPROFILE_FINGERPRINT_MAX_GLOBS,
} from './limits';
import { fingerprintGlobSchema, uiProfileSnippetSchema } from './types';
import { type MockupViolationReason, validateMockup } from './validate';

/**
 * The result of a `uiprofile.build` run (docs/specs/223-design-stage.md
 * "Output contract (v2)", D12): one `agentdock-plan` block holding the
 * `profile` object. The runner does not parse it; the API does, here.
 */

export const uiProfileOutputSchema = z.strictObject({
  action: z.literal('profile'),
  hasUi: z.boolean(),
  summary: z.string().trim().min(1).max(UI_PROFILE_SUMMARY_MAX),
  kit: z.string(),
  snippets: z
    .array(uiProfileSnippetSchema)
    .max(UI_PROFILE_SNIPPETS_MAX)
    .refine((ss) => new Set(ss.map((s) => s.name)).size === ss.length, {
      message: 'snippet names must be unique',
    }),
  fingerprintGlobs: z
    .array(fingerprintGlobSchema)
    .max(UIPROFILE_FINGERPRINT_MAX_GLOBS),
});
export type UiProfileOutput = z.infer<typeof uiProfileOutputSchema>;

/**
 * The fixed contract text of a profile build, appended to its prompt the way
 * `PLANNER_OUTPUT_CONTRACT` is to a plan turn's (spec 223 D12–D14). The API
 * adds the obligations of manual versions (D14) above it.
 */
export const UI_PROFILE_OUTPUT_CONTRACT = `# Output contract (UI profile)

This contract is fixed. It overrides anything above it about the shape of
your answer.

You are describing this repository's user interface so that HTML mockups of
new screens can look like it. Read the code; do not run it. Your final message
must contain exactly one fenced block tagged \`${PLANNER_BLOCK_TAG}\`, holding
one JSON object. Every object below is closed: a key it does not name fails
the build.

\`\`\`
{
  "action": "profile",
  "hasUi": boolean,              // false: the project has no user interface
  "summary": markdown,           // libraries and versions, styling approach, tokens,
                                 // components with import paths, screen patterns,
                                 // theme support, icons
  "kit": css,                    // CSS custom properties for the tokens, base
                                 // typography, styles of the key components;
                                 // light and dark under :root[data-theme="light"|"dark"]
  "snippets": [ { "name": string, "html": string } ],   // button, input, card, table, …
  "fingerprintGlobs": [ glob ]   // the files this profile was built from
}
\`\`\`

Rules:

- \`kit\` is at most ${UI_PROFILE_KIT_MAX_BYTES / 1024} KiB; at most ${UI_PROFILE_SNIPPETS_MAX} snippets, names unique.
- \`kit\` and \`snippets\` follow the mockup rules: no host off the CDN allowlist, exact versions, no network calls.
- \`fingerprintGlobs\`: at most ${UIPROFILE_FINGERPRINT_MAX_GLOBS}, repository-relative, no \`..\`, no absolute path — the theme, token, component and layout files a change to which should rebuild this profile.
- With \`hasUi: false\`, \`kit\` is "" and \`snippets\` is [].
`;

export const UI_PROFILE_VIOLATION_REASONS = [
  'no_block',
  'multiple_blocks',
  'invalid_json',
  /** The block's `action` is not `profile`. */
  'action_mismatch',
  'unknown_key',
  'invalid_shape',
  /** "Open questions": the kit is over `UI_PROFILE_KIT_MAX_BYTES`. */
  'kit_too_large',
  /** The kit or a snippet loads from a host off the allowlist, or a relative URL. */
  'design_host_not_allowed',
  'design_unpinned_version',
  'design_forbidden_feature',
] as const;
export type UiProfileViolationReason =
  (typeof UI_PROFILE_VIOLATION_REASONS)[number];

export interface UiProfileContractViolation {
  code: 'contract_violation';
  reason: UiProfileViolationReason;
  message: string;
}

export type UiProfileParseResult =
  | { ok: true; output: UiProfileOutput }
  | { ok: false; error: UiProfileContractViolation };

const violation = (
  reason: UiProfileViolationReason,
  message: string,
): UiProfileParseResult => ({
  ok: false,
  error: { code: 'contract_violation', reason, message },
});

/** A mockup reason a kit or snippet can break; size is checked on its own. */
const asProfileReason = (
  reason: MockupViolationReason,
): UiProfileViolationReason =>
  reason === 'design_too_large' ? 'kit_too_large' : reason;

export type UiProfileContentCheck =
  | { ok: true }
  | { ok: false; reason: UiProfileViolationReason; message: string };

/**
 * The mockup rules (D6) over a profile's kit and snippets. A build's output
 * and a person's `PUT /ui-profile` edit both pass through it: every mockup
 * reuses them, so one that breaks a rule breaks every design turn after it.
 */
export const validateProfileContent = (
  kit: string,
  snippets: readonly { name: string; html: string }[],
): UiProfileContentCheck => {
  const kitCheck = validateMockup(`<style>${kit}</style>`, {
    maxBytes: UI_PROFILE_KIT_MAX_BYTES + 16,
  });
  if (!kitCheck.ok) {
    return {
      ok: false,
      reason: asProfileReason(kitCheck.reason),
      message: `kit: ${kitCheck.message}`,
    };
  }
  for (const snippet of snippets) {
    const check = validateMockup(snippet.html, {
      maxBytes: UI_PROFILE_SNIPPET_MAX_BYTES,
    });
    if (!check.ok) {
      return {
        ok: false,
        reason: asProfileReason(check.reason),
        message: `snippet ${snippet.name}: ${check.message}`,
      };
    }
  }
  return { ok: true };
};

/**
 * Validates a profile build's final message. The kit and every snippet go
 * through the mockup rules (D6) too: every mockup reuses them, so a profile
 * that breaks a rule would fail every design turn after it.
 */
export const parseUiProfileOutput = (text: string): UiProfileParseResult => {
  const blocks = extractPlannerBlocks(text);
  if (blocks.length > 1) {
    return violation(
      'multiple_blocks',
      `expected one ${PLANNER_BLOCK_TAG} block, found ${blocks.length}`,
    );
  }
  const block = blocks[0];
  if (block === undefined || block === null) {
    return violation(
      'no_block',
      block === null
        ? `the ${PLANNER_BLOCK_TAG} block is never closed`
        : `no ${PLANNER_BLOCK_TAG} block`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(block);
  } catch (error) {
    return violation(
      'invalid_json',
      error instanceof Error ? error.message : 'not JSON',
    );
  }
  if (
    typeof json === 'object' &&
    json !== null &&
    'action' in json &&
    json.action !== 'profile'
  ) {
    return violation(
      'action_mismatch',
      `expected action profile, got ${String(json.action)}`,
    );
  }
  const parsed = uiProfileOutputSchema.safeParse(json);
  if (!parsed.success) {
    const unknown = parsed.error.issues.find(
      (i) => i.code === 'unrecognized_keys',
    );
    const issue = unknown ?? parsed.error.issues[0];
    const path = issue?.path.length
      ? issue.path.map(String).join('.')
      : '(root)';
    return violation(
      unknown ? 'unknown_key' : 'invalid_shape',
      issue ? `${path}: ${issue.message}` : 'invalid output',
    );
  }
  const output = parsed.data;

  const kitBytes = designBytes(output.kit);
  if (kitBytes > UI_PROFILE_KIT_MAX_BYTES) {
    return violation(
      'kit_too_large',
      `the kit is ${kitBytes} bytes; at most ${UI_PROFILE_KIT_MAX_BYTES} — every mockup carries it, so keep it to tokens, typography and the key components`,
    );
  }
  const content = validateProfileContent(output.kit, output.snippets);
  if (!content.ok) return violation(content.reason, content.message);
  return { ok: true, output };
};
