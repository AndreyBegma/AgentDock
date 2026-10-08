import { describe, expect, it } from 'bun:test';
import {
  CONTROL_TIMEOUTS_MS,
  commandErrorCodeSchema,
  commands,
  controlCommands,
  ORCHESTRATOR_DEFAULTS,
  type OrchestratorStartArgs,
  orchestratorModelSchema,
  orchestratorPermissionModeSchema,
  orchestratorSessionName,
  orchestratorStartArgsSchema,
  orchestratorStatusResultSchema,
  SLOT_MESSAGE_MAX_BYTES,
  slotMessageArgsSchema,
  slotNameSchema,
  slotStopArgsSchema,
} from '../index';

const target = { projectId: 'prj_agentdock', root: '/home/dev/AgentDock' };

const startArgs: OrchestratorStartArgs = {
  ...target,
  profileId: 'claude-main',
  model: 'opus',
  permissionMode: 'auto',
  mode: 'start',
};

const messageArgs = {
  ...target,
  slot: 'i42',
  text: 'Rebase on develop, then rerun the checks.',
  from: 'operator@example.com',
};

describe('slotNameSchema', () => {
  it.each([
    'i42',
    'i17-protocol',
    '5',
    'a'.repeat(64),
  ])('accepts %s', (slot) => {
    expect(slotNameSchema.safeParse(slot).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a slash', 'i42/x'],
    ['a parent reference', '..'],
    ['a dot', 'i42.x'],
    ['uppercase', 'I42'],
    ['a leading dash', '-i42'],
    ['a tmux target separator', 'i42:0'],
    ['whitespace', 'i42 x'],
    ['65 characters', 'a'.repeat(65)],
  ])('rejects %s', (_why, slot) => {
    expect(slotNameSchema.safeParse(slot).success).toBe(false);
  });
});

describe('orchestratorSessionName', () => {
  it('slugs owner/name per D1', () => {
    expect(orchestratorSessionName('AndreyBegma/AgentDock')).toBe(
      'agentdock-orch-andreybegma-agentdock',
    );
    expect(orchestratorSessionName('acme/my.repo_v2')).toBe(
      'agentdock-orch-acme-my-repo-v2',
    );
  });

  it('never yields a slot session name', () => {
    expect(orchestratorSessionName('cs/x').startsWith('cs-')).toBe(false);
  });
});

describe('orchestrator.start args', () => {
  it('accepts the spec shape', () => {
    expect(orchestratorStartArgsSchema.parse(startArgs)).toEqual(startArgs);
  });

  it('defaults are valid values', () => {
    expect(orchestratorModelSchema.parse(ORCHESTRATOR_DEFAULTS.model)).toBe(
      'opus',
    );
    expect(
      orchestratorPermissionModeSchema.parse(
        ORCHESTRATOR_DEFAULTS.permissionMode,
      ),
    ).toBe('auto');
  });

  it.each([
    'opus',
    'claude-opus-5-5',
    'opus[1m]',
  ])('accepts model %s', (model) => {
    expect(orchestratorModelSchema.safeParse(model).success).toBe(true);
  });

  it.each([
    ['a flag', '--dangerously-skip-permissions'],
    ['empty', ''],
    ['a space', 'opus sonnet'],
    ['a shell metacharacter', 'opus;rm'],
  ])('rejects a model that is %s', (_why, model) => {
    expect(
      orchestratorStartArgsSchema.safeParse({ ...startArgs, model }).success,
    ).toBe(false);
  });

  it('rejects an unknown mode, permission mode or extra field', () => {
    for (const bad of [
      { ...startArgs, mode: 'status' },
      { ...startArgs, permissionMode: 'default' },
      { ...startArgs, argv: ['sh', '-c', 'id'] },
      { ...startArgs, root: 'relative/path' },
    ]) {
      expect(orchestratorStartArgsSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('orchestrator.status result', () => {
  it('pairs absent with present: false', () => {
    expect(
      orchestratorStatusResultSchema.safeParse({
        present: false,
        state: 'absent',
      }).success,
    ).toBe(true);
    expect(
      orchestratorStatusResultSchema.safeParse({
        present: true,
        state: 'idle',
        session: 'agentdock-orch-acme-repo',
        startedAt: '2026-10-08T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects a state that contradicts presence', () => {
    for (const bad of [
      { present: true, state: 'absent' },
      { present: false, state: 'running' },
    ]) {
      expect(orchestratorStatusResultSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('slot.stop and slot.message args', () => {
  it('rejects an unsafe slot before anything runs', () => {
    for (const slot of ['../x', 'I42', 'a/b']) {
      expect(slotStopArgsSchema.safeParse({ ...target, slot }).success).toBe(
        false,
      );
      expect(
        slotMessageArgsSchema.safeParse({ ...messageArgs, slot }).success,
      ).toBe(false);
    }
  });

  it('accepts a message up to the byte limit, counted in UTF-8', () => {
    const atLimit = 'a'.repeat(SLOT_MESSAGE_MAX_BYTES);
    expect(
      slotMessageArgsSchema.safeParse({ ...messageArgs, text: atLimit })
        .success,
    ).toBe(true);
    // 'é' is two bytes: half the limit in characters is exactly the limit.
    const twoByte = 'é'.repeat(SLOT_MESSAGE_MAX_BYTES / 2);
    expect(
      slotMessageArgsSchema.safeParse({ ...messageArgs, text: twoByte })
        .success,
    ).toBe(true);
    expect(
      slotMessageArgsSchema.safeParse({ ...messageArgs, text: `${twoByte}é` })
        .success,
    ).toBe(false);
  });

  it('rejects a blank message and a sender that is not an email', () => {
    for (const bad of [
      { ...messageArgs, text: '' },
      { ...messageArgs, text: ' \n ' },
      { ...messageArgs, from: 'not-an-email' },
    ]) {
      expect(slotMessageArgsSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('controlCommands', () => {
  it('carries the D9 roles and D11 timeouts', () => {
    expect(
      Object.fromEntries(
        Object.entries(controlCommands).map(([name, d]) => [
          name,
          [d.minRole, d.timeoutMs],
        ]),
      ),
    ).toEqual({
      'orchestrator.start': ['operator', CONTROL_TIMEOUTS_MS.start],
      'orchestrator.stop': ['operator', 10_000],
      'orchestrator.status': ['viewer', 5_000],
      'slot.stop': ['operator', 10_000],
      'slot.message': ['operator', 10_000],
    });
    expect(CONTROL_TIMEOUTS_MS.start).toBe(30_000);
  });

  it('is not in the allowlist until the runner registers its handlers', () => {
    for (const name of Object.keys(controlCommands)) {
      expect(Object.hasOwn(commands, name)).toBe(false);
    }
  });

  it('has the error codes its handlers answer with', () => {
    for (const code of [
      'already_running',
      'unsupported_runtime',
      'unknown_profile',
      'invalid_args',
      'path_not_allowed',
    ]) {
      expect(commandErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});
