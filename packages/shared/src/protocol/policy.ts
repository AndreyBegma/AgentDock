import { z } from 'zod';
import { boundedName, LIST_MAX, TEXT_NAME_MAX } from './bounded';
// Type-only: `./commands` imports this module through `./capabilities`.
import type { CommandName } from './commands';
import {
  type OrchestratorPermissionMode,
  orchestratorPermissionModeSchema,
} from './commands/control';
import { absolutePathSchema } from './projects';

/**
 * The runner-local security policy (ADR-0047). It lives in the runner's own
 * `runner.json`, written only by `nautelle-runner policy …` on the machine;
 * no server command or `hello` response changes it. The runner reports it in
 * `hello` so the UI can explain a refusal before the person asks.
 */

/**
 * Commands that type free text into a live agent session whose permission
 * mode the policy may not have set (a fleet slot, the orchestrator, a card
 * round). Off until the person turns one on with `policy set commands.<name>`.
 */
export const POLICY_GATED_COMMANDS = [
  'orchestrator.message',
  'slot.message',
  'session.message',
] as const satisfies readonly CommandName[];
export type PolicyGatedCommand = (typeof POLICY_GATED_COMMANDS)[number];

/** The rule a `policy_refused` failure names. */
export const policyRuleSchema = z.enum([
  'allowedRoots',
  'maxPermissionMode',
  'terminal.write',
  'skills.profileInstall',
  'commands',
  'code.deny',
]);
export type PolicyRule = z.infer<typeof policyRuleSchema>;

/** Least to most permissive; `maxPermissionMode` caps a launch at its rank. */
export const PERMISSION_MODE_RANK: Record<OrchestratorPermissionMode, number> =
  { manual: 0, acceptEdits: 1, auto: 2, bypassPermissions: 3 };

/** The default cap: every mode below `bypassPermissions`. */
export const POLICY_DEFAULT_MAX_PERMISSION_MODE: OrchestratorPermissionMode =
  'auto';

export const permissionModeAllowed = (
  mode: OrchestratorPermissionMode,
  max: OrchestratorPermissionMode,
): boolean => PERMISSION_MODE_RANK[mode] <= PERMISSION_MODE_RANK[max];

/** At most this many allowed roots; a person lists directories, not projects. */
export const POLICY_ALLOWED_ROOTS_MAX = 64;

/** At most this many `code.deny` patterns. */
export const POLICY_CODE_DENY_MAX = 64;

/**
 * A `code.deny` pattern (#622): a glob over checkout-relative paths — `*`
 * and `?` within a segment, `**` across segments. A pattern without `/`
 * matches a file or directory name at any depth, as in `.gitignore`.
 */
export const policyCodeDenySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
  .refine((p) => !/[\u0000-\u001f\u007f]/.test(p), {
    message: 'must not contain control characters',
  });

/** The effective policy as `hello` reports it: values only, no other paths. */
export const runnerPolicySchema = z.object({
  /** Real paths; a watched root must be inside one of them. */
  allowedRoots: z.array(absolutePathSchema).max(POLICY_ALLOWED_ROOTS_MAX),
  maxPermissionMode: orchestratorPermissionModeSchema,
  terminal: z.object({ write: z.boolean() }),
  skills: z.object({ profileInstall: z.boolean() }),
  /**
   * One entry per gated command this runner knows. Plain string keys, not
   * `POLICY_GATED_COMMANDS`: a newer runner may gate a command the API does
   * not know, and an enum would fail its whole hello.
   */
  commands: z
    .record(boundedName(TEXT_NAME_MAX), z.boolean())
    .refine((c) => Object.keys(c).length <= LIST_MAX, {
      message: `at most ${LIST_MAX} commands`,
    }),
  /**
   * #622: paths `repo.search`, `repo.read` and `code.ask` never return, on
   * top of the secrets every runner refuses. Absent on a runner older than it.
   */
  code: z
    .object({
      deny: z.array(policyCodeDenySchema).max(POLICY_CODE_DENY_MAX),
    })
    .optional(),
});
export type RunnerPolicy = z.infer<typeof runnerPolicySchema>;

/** Whether the policy lets `name` run; a command it does not gate always may. */
export const policyAllowsCommand = (
  policy: Pick<RunnerPolicy, 'commands'>,
  name: string,
): boolean =>
  !(POLICY_GATED_COMMANDS as readonly string[]).includes(name) ||
  policy.commands[name] === true;

/** The CLI line that lifts `rule`, for a refusal message and the UI. */
export const policyFixHint = (rule: PolicyRule, detail?: string): string => {
  switch (rule) {
    case 'allowedRoots':
      return `nautelle-runner policy allow-root ${detail ?? '<dir>'}`;
    case 'maxPermissionMode':
      return `nautelle-runner policy set maxPermissionMode ${detail ?? '<mode>'}`;
    case 'terminal.write':
      return 'nautelle-runner policy set terminal.write true';
    case 'skills.profileInstall':
      return 'nautelle-runner policy set skills.profileInstall true';
    case 'commands':
      return `nautelle-runner policy set commands.${detail ?? '<command>'} true`;
    case 'code.deny':
      return `nautelle-runner policy allow-path ${detail ?? '<pattern>'}`;
  }
};

/**
 * The words of every `policy_refused`: the rule, why, then the CLI line
 * that lifts it. The runner refuses with it; the API says it too when the
 * runner's reported policy already refuses a command (#913).
 */
export const policyRefusalMessage = (
  rule: PolicyRule,
  why: string,
  detail?: string,
): string =>
  `refused by this runner's policy (${rule}): ${why}. On the runner's machine: \`${policyFixHint(rule, detail)}\``;
