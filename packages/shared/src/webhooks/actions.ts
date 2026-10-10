import { z } from 'zod';
import { orchestratorModelSchema } from '../protocol/commands/control';
import {
  profileKeySchema,
  SKILL_RUN_ARGS_MAX_BYTES,
  skillArgsTextSchema,
  skillInvocationSchema,
  skillRunOutputSchema,
} from '../protocol/commands/skills';

/**
 * What an inbound trigger starts (docs/specs/26-webhooks.md D3), stored as
 * `inbound_triggers.action`. A closed union: only a skill run (#24) or
 * `orchestrator next` (#17) — never `orchestrator stop`, `slot.*` or any other
 * runner command.
 */
export const inboundSkillActionSchema = z.strictObject({
  kind: z.literal('skill'),
  skill: skillInvocationSchema,
  /** A D4 template: text and `{{payload.<path>}}` placeholders only. */
  args: skillArgsTextSchema,
  /** The project's default profile when absent (#10 D13). */
  profileKey: profileKeySchema.optional(),
  /** `ORCHESTRATOR_DEFAULTS.model` when absent. */
  model: orchestratorModelSchema.optional(),
  output: skillRunOutputSchema,
});
export type InboundSkillAction = z.infer<typeof inboundSkillActionSchema>;

export const inboundOrchestratorActionSchema = z.strictObject({
  kind: z.literal('orchestrator'),
  mode: z.literal('next'),
});
export type InboundOrchestratorAction = z.infer<
  typeof inboundOrchestratorActionSchema
>;

export const inboundTriggerActionSchema = z.discriminatedUnion('kind', [
  inboundSkillActionSchema,
  inboundOrchestratorActionSchema,
]);
export type InboundTriggerAction = z.infer<typeof inboundTriggerActionSchema>;

/** D4: the default `valuePattern`. No backtick, `$`, `(`, quotes, `;`, `|`, `&`, `<`, `>` or newline. */
export const DEFAULT_INBOUND_VALUE_PATTERN = '^[\\w .,:/#@+-]*$';
/** D4: longest stringified value a placeholder may render. */
export const INBOUND_VALUE_MAX_CHARS = 500;
/** Longest `valuePattern` an admin may set. */
export const INBOUND_VALUE_PATTERN_MAX_CHARS = 500;
/** Most `allowedPaths` one trigger may list. */
export const INBOUND_ALLOWED_PATHS_MAX = 50;
/** Most dotted segments in one path. */
export const INBOUND_PATH_MAX_SEGMENTS = 10;

const SEGMENT = '[A-Za-z0-9_-]{1,64}';
/** A payload path: dotted segments; a numeric segment indexes an array. */
const PATH_PATTERN = new RegExp(
  `^${SEGMENT}(?:\\.${SEGMENT}){0,${INBOUND_PATH_MAX_SEGMENTS - 1}}$`,
);

export const inboundPayloadPathSchema = z
  .string()
  .regex(PATH_PATTERN, 'must be dotted segments of [A-Za-z0-9_-]');

/** `{{payload.<path>}}` — the only placeholder D4 allows; no spaces inside. */
const PLACEHOLDER = /\{\{payload\.([^{}]*)\}\}/g;

/** Why a template, or a payload against it, was refused (D4). */
export const INBOUND_TEMPLATE_ERRORS = {
  /** `{{` or `}}` that is not a well-formed `{{payload.<path>}}`. */
  badPlaceholder: 'bad_placeholder',
  /** The template references a path not in `allowedPaths`. */
  pathNotAllowed: 'path_not_allowed',
  /** The payload has no value at the path. */
  pathMissing: 'path_missing',
  /** The value is an object, an array or null. */
  notScalar: 'not_scalar',
  /** The stringified value is longer than `INBOUND_VALUE_MAX_CHARS`. */
  tooLong: 'too_long',
  /** The stringified value does not match `valuePattern`. */
  patternMismatch: 'pattern_mismatch',
  /** The rendered args exceed `SKILL_RUN_ARGS_MAX_BYTES`. */
  argsTooLong: 'args_too_long',
} as const;
export type InboundTemplateError =
  (typeof INBOUND_TEMPLATE_ERRORS)[keyof typeof INBOUND_TEMPLATE_ERRORS];

export type TemplateParse =
  | { ok: true; paths: string[] }
  | { ok: false; reason: InboundTemplateError; path?: string };

/**
 * The paths a D4 template references, in order, without duplicates. Refuses a
 * stray `{{`/`}}` or a malformed path, so nothing but a placeholder can look
 * like one.
 */
export const parseArgsTemplate = (template: string): TemplateParse => {
  const paths: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const path = match[1];
    if (!PATH_PATTERN.test(path)) {
      return {
        ok: false,
        reason: INBOUND_TEMPLATE_ERRORS.badPlaceholder,
        path,
      };
    }
    if (!paths.includes(path)) paths.push(path);
  }
  const rest = template.replace(PLACEHOLDER, '');
  if (rest.includes('{{') || rest.includes('}}')) {
    return { ok: false, reason: INBOUND_TEMPLATE_ERRORS.badPlaceholder };
  }
  return { ok: true, paths };
};

/**
 * Checked at create and update: the template parses and every path it uses is
 * allowed. The same check runs again at fire time inside `renderArgsTemplate`.
 */
export const checkArgsTemplate = (
  template: string,
  allowedPaths: readonly string[],
): TemplateParse => {
  const parsed = parseArgsTemplate(template);
  if (!parsed.ok) return parsed;
  const denied = parsed.paths.find((path) => !allowedPaths.includes(path));
  return denied === undefined
    ? parsed
    : {
        ok: false,
        reason: INBOUND_TEMPLATE_ERRORS.pathNotAllowed,
        path: denied,
      };
};

/** A `valuePattern` an admin may store: compiles, and is not absurdly long. */
export const isValidValuePattern = (pattern: string): boolean => {
  if (pattern.length === 0 || pattern.length > INBOUND_VALUE_PATTERN_MAX_CHARS)
    return false;
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
};

/** Own properties only, so a path never reaches `Object.prototype`. */
const lookup = (
  payload: unknown,
  path: string,
): { found: boolean; value: unknown } => {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object')
      return { found: false, value: undefined };
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { found: false, value: undefined };
      const index = Number(segment);
      if (index >= current.length) return { found: false, value: undefined };
      current = current[index];
    } else {
      if (!Object.hasOwn(current, segment))
        return { found: false, value: undefined };
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return { found: true, value: current };
};

const stringify = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

export type RenderedArgs =
  | { ok: true; args: string }
  | { ok: false; reason: InboundTemplateError; path?: string };

/**
 * D4 at fire time and in the dry run — one verdict for both. Substitutes each
 * placeholder with the payload's value at its path; refuses a disallowed or
 * missing path, a non-scalar, a value over `INBOUND_VALUE_MAX_CHARS`, a value
 * not matching `valuePattern` (default `DEFAULT_INBOUND_VALUE_PATTERN`), and a
 * result over `SKILL_RUN_ARGS_MAX_BYTES`. The result is data for `skill.run`,
 * never shell text (ADR-0010).
 */
export const renderArgsTemplate = (
  template: string,
  payload: unknown,
  allowedPaths: readonly string[],
  valuePattern: string | null = null,
): RenderedArgs => {
  const checked = checkArgsTemplate(template, allowedPaths);
  if (!checked.ok) return checked;
  const pattern = new RegExp(
    valuePattern ?? DEFAULT_INBOUND_VALUE_PATTERN,
    'u',
  );

  const values = new Map<string, string>();
  for (const path of checked.paths) {
    const { found, value } = lookup(payload, path);
    if (!found)
      return { ok: false, reason: INBOUND_TEMPLATE_ERRORS.pathMissing, path };
    const rendered = stringify(value);
    if (rendered === null)
      return { ok: false, reason: INBOUND_TEMPLATE_ERRORS.notScalar, path };
    if (rendered.length > INBOUND_VALUE_MAX_CHARS)
      return { ok: false, reason: INBOUND_TEMPLATE_ERRORS.tooLong, path };
    if (!pattern.test(rendered))
      return {
        ok: false,
        reason: INBOUND_TEMPLATE_ERRORS.patternMismatch,
        path,
      };
    values.set(path, rendered);
  }

  // A replacer function, so `$&` and friends in a value stay literal.
  const args = template.replace(
    PLACEHOLDER,
    (_match, path: string) => values.get(path) ?? '',
  );
  if (new TextEncoder().encode(args).length > SKILL_RUN_ARGS_MAX_BYTES)
    return { ok: false, reason: INBOUND_TEMPLATE_ERRORS.argsTooLong };
  return { ok: true, args };
};
