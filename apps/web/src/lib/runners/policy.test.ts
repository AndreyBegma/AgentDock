import { describe, expect, it } from 'bun:test';
import { describeRefusal } from '../terminal/format';
import {
  describePolicyRefusal,
  parsePolicyRefusal,
  policyRows,
} from './policy';

const RUNNER_TEXT =
  "card.run: refused by this runner's policy (maxPermissionMode): card.run asks for bypassPermissions, this runner allows at most auto. On the runner's machine: `agentdock-runner policy set maxPermissionMode bypassPermissions`";

describe('runner policy refusals (ADR-0047)', () => {
  it('reads the rule, the reason and the fix out of the runner text', () => {
    expect(parsePolicyRefusal(RUNNER_TEXT)).toEqual({
      rule: 'maxPermissionMode',
      reason:
        'card.run asks for bypassPermissions, this runner allows at most auto',
      fix: 'agentdock-runner policy set maxPermissionMode bypassPermissions',
    });
    expect(parsePolicyRefusal('card.run failed on the runner: internal')).toBe(
      null,
    );
  });

  it('says it as one sentence with the command that allows it', () => {
    expect(describePolicyRefusal(RUNNER_TEXT)).toBe(
      'The runner’s local security policy refused this (Highest permission mode): card.run asks for bypassPermissions, this runner allows at most auto. To allow it, run `agentdock-runner policy set maxPermissionMode bypassPermissions` on that machine.',
    );
    expect(describePolicyRefusal(undefined)).toContain(
      'agentdock-runner policy',
    );
  });

  it('explains a terminal write refusal with the runner reason, or without it', () => {
    const message =
      "refused by this runner's policy (terminal.write): a write attach is off on this runner. On the runner's machine: `agentdock-runner policy set terminal.write true`";
    expect(describeRefusal('policy_refused', undefined, message)).toContain(
      'Typing into a terminal',
    );
    expect(describeRefusal('policy_refused')).toContain('read-only');
  });

  it('lists the policy from hello capabilities, and nothing for an older runner', () => {
    expect(policyRows({ tmux: null })).toEqual([]);
    const rows = policyRows({
      policy: {
        allowedRoots: [],
        maxPermissionMode: 'auto',
        terminal: { write: false },
        skills: { profileInstall: true },
        commands: { 'slot.message': true, 'session.message': false },
      },
    });
    expect(rows.map((r) => r.value)).toEqual([
      'none — no project is watched',
      'auto',
      'off',
      'allowed',
      'slot.message',
    ]);
  });

  it('shows code.deny when the runner reports it, and reads its refusal (#622)', () => {
    const base = {
      allowedRoots: ['/srv'],
      maxPermissionMode: 'auto',
      terminal: { write: false },
      skills: { profileInstall: false },
      commands: {},
    };
    expect(
      policyRows({ policy: { ...base, code: { deny: ['internal'] } } }).at(-1),
    ).toEqual({
      label: 'Files the assistant may not read',
      value: 'secrets, internal',
    });
    expect(
      policyRows({ policy: { ...base, code: { deny: [] } } }).at(-1)?.value,
    ).toBe('secrets only');
    expect(
      parsePolicyRefusal(
        "refused by this runner's policy (code.deny): internal/a.ts matches the deny-path pattern internal. On the runner's machine: `agentdock-runner policy allow-path internal`",
      )?.rule,
    ).toBe('code.deny');
  });
});
