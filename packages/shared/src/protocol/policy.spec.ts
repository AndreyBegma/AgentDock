import { describe, expect, it } from 'bun:test';
import {
  capabilitiesSchema,
  commandErrorCodeSchema,
  commandNames,
  commandPolicyRefusalOf,
  POLICY_GATED_COMMANDS,
  permissionModeAllowed,
  policyAllowsCommand,
  type RunnerPolicy,
  runnerPolicyOf,
  watchedProjectSchema,
} from './index';

const policy: RunnerPolicy = {
  allowedRoots: ['/srv/dev'],
  maxPermissionMode: 'auto',
  terminal: { write: false },
  skills: { profileInstall: false },
  commands: { 'slot.message': false, 'a.command.from.the.future': true },
};

const base = {
  tmux: null,
  git: null,
  gh: null,
  runtimes: { claude: null, codex: null },
  profiles: [],
  codeSentinel: null,
  otlp: null,
};

describe('runner policy (ADR-0047)', () => {
  it('rides in hello capabilities; a gated command the API does not know keeps the hello valid', () => {
    const parsed = capabilitiesSchema.parse({ ...base, policy });
    expect(parsed.policy).toEqual(policy);
    expect(runnerPolicyOf(parsed)).toEqual(policy);
    expect(runnerPolicyOf(base)).toBeNull();
  });

  it('caps permission modes by rank: bypassPermissions is above auto', () => {
    expect(permissionModeAllowed('auto', 'auto')).toBe(true);
    expect(permissionModeAllowed('manual', 'auto')).toBe(true);
    expect(permissionModeAllowed('bypassPermissions', 'auto')).toBe(false);
  });

  it('gates only the listed commands, all of them real commands', () => {
    for (const name of POLICY_GATED_COMMANDS) {
      expect(commandNames).toContain(name);
      expect(policyAllowsCommand(policy, name)).toBe(false);
    }
    expect(policyAllowsCommand(policy, 'card.run')).toBe(true);
  });

  it('#913: words a gated command that is off as the runner refuses it', () => {
    expect(commandPolicyRefusalOf({ ...base, policy }, 'session.message')).toBe(
      "refused by this runner's policy (commands): session.message is off on this runner. On the runner's machine: `nautelle-runner policy set commands.session.message true`",
    );
    const on = { ...policy, commands: { 'session.message': true } };
    expect(
      commandPolicyRefusalOf({ ...base, policy: on }, 'session.message'),
    ).toBeNull();
    // A runner older than the policy refuses nothing it did not report.
    expect(commandPolicyRefusalOf(base, 'session.message')).toBeNull();
  });

  it('has a policy_refused error code', () => {
    expect(commandErrorCodeSchema.options).toContain('policy_refused');
  });

  it('refuses a relative watch-list root', () => {
    expect(
      watchedProjectSchema.safeParse({ id: 'p', root: 'dev/app' }).success,
    ).toBe(false);
  });
});
