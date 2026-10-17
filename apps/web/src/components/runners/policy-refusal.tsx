import { POLICY_RULE_LABEL, parsePolicyRefusal } from '@/lib/runners/policy';

/**
 * ADR-0047: why a runner's local security policy refused a command — the rule,
 * the runner's reason and the command that allows it on that machine. Text
 * that is no policy refusal renders as it is.
 */
export function PolicyRefusalText({ text }: { text: string }) {
  const refusal = parsePolicyRefusal(text);
  if (!refusal) return <span className="text-danger">{text}</span>;
  return (
    <span className="text-danger break-words">
      Refused by the runner’s security policy ({POLICY_RULE_LABEL[refusal.rule]}
      ): {refusal.reason}. To allow it, run{' '}
      <span className="font-mono">{refusal.fix}</span> on that machine.
    </span>
  );
}
