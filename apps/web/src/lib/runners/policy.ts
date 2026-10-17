import {
  type PolicyRule,
  policyRuleSchema,
  type RunnerPolicy,
  runnerPolicyOf,
} from '@agentdock/shared/protocol';

/**
 * ADR-0047: a runner's local security policy refusal, as the runner words it:
 * "refused by this runner's policy (<rule>): <why>. On the runner's machine:
 * `<command>`". The API passes that text on in the error message (prefixed
 * with the command name on the board), and a failed round stores it.
 */
const REFUSAL =
  /refused by this runner's policy \(([^)]+)\): (.+?)\. On the runner's machine: `([^`]+)`/;

export interface PolicyRefusal {
  rule: PolicyRule;
  /** Why, as the runner said it. */
  reason: string;
  /** The CLI line the person runs on that machine to lift the rule. */
  fix: string;
}

/** The refusal in `text`, or null when it is no policy refusal. */
export function parsePolicyRefusal(
  text: string | null | undefined,
): PolicyRefusal | null {
  const match = text ? REFUSAL.exec(text) : null;
  if (!match) return null;
  const rule = policyRuleSchema.safeParse(match[1]);
  if (!rule.success) return null;
  return { rule: rule.data, reason: match[2], fix: match[3] };
}

/** What each rule protects, in the person's words. */
export const POLICY_RULE_LABEL: Record<PolicyRule, string> = {
  allowedRoots: 'Allowed project folders',
  maxPermissionMode: 'Highest permission mode',
  'terminal.write': 'Typing into a terminal',
  'skills.profileInstall': 'Installing skills into a Claude profile',
  commands: 'Messages into running sessions',
};

/**
 * A refusal as one sentence: the rule, why, and the command that allows it.
 * `fallback` when `text` is no policy refusal the runner worded.
 */
export function describePolicyRefusal(
  text: string | null | undefined,
  fallback = 'The runner’s local security policy refused this. Only the person on that machine can change it, with `agentdock-runner policy`.',
): string {
  const refusal = parsePolicyRefusal(text);
  if (!refusal) return fallback;
  return `The runner’s local security policy refused this (${POLICY_RULE_LABEL[refusal.rule]}): ${refusal.reason}. To allow it, run \`${refusal.fix}\` on that machine.`;
}

/** The policy a runner reported in `hello`, as label / value rows; [] when it has none. */
export function policyRows(
  capabilities: unknown,
): { label: string; value: string }[] {
  const policy: RunnerPolicy | null = runnerPolicyOf(capabilities);
  if (!policy) return [];
  const onOff = (on: boolean) => (on ? 'allowed' : 'off');
  const gated = Object.entries(policy.commands);
  return [
    {
      label: POLICY_RULE_LABEL.allowedRoots,
      value:
        policy.allowedRoots.length > 0
          ? policy.allowedRoots.join(', ')
          : 'none — no project is watched',
    },
    {
      label: POLICY_RULE_LABEL.maxPermissionMode,
      value: policy.maxPermissionMode,
    },
    {
      label: POLICY_RULE_LABEL['terminal.write'],
      value: onOff(policy.terminal.write),
    },
    {
      label: POLICY_RULE_LABEL['skills.profileInstall'],
      value: onOff(policy.skills.profileInstall),
    },
    {
      label: POLICY_RULE_LABEL.commands,
      value:
        gated
          .filter(([, on]) => on)
          .map(([name]) => name)
          .join(', ') || 'off',
    },
  ];
}
