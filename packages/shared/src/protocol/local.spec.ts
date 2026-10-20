import { describe, expect, it } from 'bun:test';
import {
  ACTION_REQUEST_KINDS,
  ACTION_REQUEST_TOOL_INPUT_MAX,
  actionRequestArgsSchemas,
  mayDecideActionRequest,
} from '../action-requests';
import {
  HOOK_CLI_EVENT,
  HOOK_CLI_NAMES,
  HOOK_CONTENT_MAX_CHARS,
  HOOK_EVENT_TYPES,
  hookEventDataSchemas,
  hookEventHasContent,
  LOCAL_ROLE_CAP,
  localActionRequestArgsSchema,
  localMethodNames,
  localMethods,
  localResponseMessageSchema,
  manualTerminalTargetSchema,
  parseHookEvent,
  parseLocalRequest,
  type RunnerEvent,
  roleAtLeast,
  runnerMessageSchema,
  serverMessageSchema,
  terminalTargetSchema,
} from './index';

describe('the local method allowlist (spec 201 D7)', () => {
  it('answers an unknown method with unknown_method', () => {
    const parsed = parseLocalRequest('shell.exec', { cmd: 'rm -rf /' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('unknown_method');
  });

  it('refuses extra args, so nothing rides along', () => {
    const parsed = parseLocalRequest('issue.create', {
      title: 't',
      body: '',
      queue: true,
      projectId: 'prj_other',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('invalid_args');
  });

  it('never takes the project as an argument (D9)', () => {
    for (const name of localMethodNames) {
      const shape = (localMethods[name].args as { shape?: object }).shape ?? {};
      expect([name, 'projectId' in shape]).toEqual([name, false]);
    }
  });

  it('applies defaults', () => {
    const parsed = parseLocalRequest('queue.list', {});
    expect(parsed).toEqual({
      ok: true,
      method: 'queue.list',
      args: { limit: 10 },
    });
  });

  it('asks at most operator of any method (D8)', () => {
    for (const name of localMethodNames) {
      expect(roleAtLeast(LOCAL_ROLE_CAP, localMethods[name].minRole)).toBe(
        true,
      );
    }
  });

  it('keeps every write at operator', () => {
    for (const name of [
      'issue.create',
      'activity.note',
      'handoff.create',
      'action.request',
      'card.track',
      'away.set',
    ] as const) {
      expect(localMethods[name].minRole).toBe('operator');
    }
  });

  describe('card.track (issue #282 D1)', () => {
    it('takes a title, and a body and a kind when given', () => {
      expect(
        parseLocalRequest('card.track', { title: '  Fix login  ' }),
      ).toEqual({
        ok: true,
        method: 'card.track',
        args: { title: 'Fix login' },
      });
      expect(
        parseLocalRequest('card.track', {
          title: 'Fix login',
          body: 'The form loses the email.',
          kind: 'bug',
        }).ok,
      ).toBe(true);
    });

    it('refuses a blank or over-long title, an over-long body and an unknown kind', () => {
      for (const args of [
        { title: '   ' },
        { title: 'x'.repeat(201) },
        { title: 't', body: 'x'.repeat(20_001) },
        { title: 't', kind: 'chore' },
      ]) {
        const parsed = parseLocalRequest('card.track', args);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.error.code).toBe('invalid_args');
      }
    });

    it('never names a card or a session: the request session resolves it', () => {
      const parsed = parseLocalRequest('card.track', {
        title: 't',
        number: 3,
      });
      expect(parsed.ok).toBe(false);
    });

    it('answers the card number, label and url', () => {
      const result = localMethods['card.track'].result;
      expect(
        result.safeParse({ number: 7, label: 'C-7', url: 'https://a/b' })
          .success,
      ).toBe(true);
      expect(result.safeParse({ number: 7, label: 'C-7' }).success).toBe(false);
    });

    it('has an error code for a session that is not manual', () => {
      expect(
        localResponseMessageSchema.safeParse({
          type: 'local.response',
          id: 'lr_1',
          ok: false,
          error: { code: 'not_a_manual_session' },
        }).success,
      ).toBe(true);
    });
  });

  it('sends local.request from the runner and local.response from the server only', () => {
    const request = {
      type: 'local.request',
      id: 'lr_1',
      method: 'fleet.status',
      args: {},
      via: 'mcp',
    };
    const response = { type: 'local.response', id: 'lr_1', ok: true, data: {} };
    expect(runnerMessageSchema.safeParse(request).success).toBe(true);
    expect(serverMessageSchema.safeParse(request).success).toBe(false);
    expect(serverMessageSchema.safeParse(response).success).toBe(true);
    expect(runnerMessageSchema.safeParse(response).success).toBe(false);
  });

  it('requires an error exactly when ok is false', () => {
    const base = { type: 'local.response', id: 'lr_1' };
    expect(
      localResponseMessageSchema.safeParse({ ...base, ok: false }).success,
    ).toBe(false);
    expect(
      localResponseMessageSchema.safeParse({
        ...base,
        ok: true,
        error: { code: 'internal' },
      }).success,
    ).toBe(false);
    expect(
      localResponseMessageSchema.safeParse({
        ...base,
        ok: false,
        error: { code: 'runner_offline' },
      }).success,
    ).toBe(true);
  });
});

const hookEvent = (type: string, data: unknown, source = 'hook'): RunnerEvent =>
  ({
    v: 1,
    seq: 1,
    ts: '2026-10-14T12:00:00.000Z',
    type,
    source,
    session: { runtime: 'claude', id: '0c9e2f4a' },
    data,
  }) as RunnerEvent;

describe('hook events (spec 201 D11)', () => {
  it('maps every CLI name the plugin calls to an event', () => {
    expect(Object.keys(HOOK_CLI_NAMES).sort()).toEqual(
      [
        'session-start',
        'permission-request',
        'user-prompt-submit',
        'post-tool-use',
        'post-tool-use-failure',
        'notification',
        'stop',
        'pre-compact',
        'session-end',
      ].sort(),
    );
    for (const type of Object.values(HOOK_CLI_EVENT)) {
      expect(HOOK_EVENT_TYPES).toContain(type);
    }
  });

  it('parses a session start', () => {
    const parsed = parseHookEvent(
      hookEvent('hook.session_started', {
        source: 'startup',
        cwd: '/home/u/dev/app',
        gitBranch: 'feat/184-grill-rounds',
        permissionMode: 'default',
        tmuxSession: 'nautelle-manual-0a1b2c3d',
      }),
    );
    expect(parsed?.ok).toBe(true);
  });

  it('refuses a hook event from another source', () => {
    const parsed = parseHookEvent(hookEvent('hook.stopped', {}, 'transcript'));
    expect(parsed?.ok).toBe(false);
  });

  it('ignores types that are not hook events', () => {
    expect(parseHookEvent(hookEvent('llm.request', {}))).toBeNull();
  });

  it('refuses unknown fields, so no stray text rides along', () => {
    const parsed = parseHookEvent(
      hookEvent('hook.notification', {
        notificationType: 'idle_prompt',
        message: 'Claude is waiting for your input',
      }),
    );
    expect(parsed?.ok).toBe(false);
  });

  it('refuses a notification type that could carry text', () => {
    expect(
      hookEventDataSchemas['hook.notification'].safeParse({
        notificationType: 'Claude needs your permission',
      }).success,
    ).toBe(false);
  });

  it('caps content at 16 KiB', () => {
    const at = (n: number) =>
      hookEventDataSchemas['hook.prompt_submitted'].safeParse({
        chars: n,
        content: { text: 'x'.repeat(n), truncated: false },
      }).success;
    expect(at(HOOK_CONTENT_MAX_CHARS)).toBe(true);
    expect(at(HOOK_CONTENT_MAX_CHARS + 1)).toBe(false);
  });

  it('tells content from metadata', () => {
    const bare = parseHookEvent(
      hookEvent('hook.prompt_submitted', { chars: 3 }),
    );
    const full = parseHookEvent(
      hookEvent('hook.prompt_submitted', {
        chars: 3,
        content: { text: 'fix', truncated: false },
      }),
    );
    if (!bare?.ok || !full?.ok) throw new Error('expected both to parse');
    expect(hookEventHasContent(bare.event)).toBe(false);
    expect(hookEventHasContent(full.event)).toBe(true);
  });
});

describe('action requests (spec 201 D18)', () => {
  it('has strict args for every kind', () => {
    for (const kind of ACTION_REQUEST_KINDS) {
      expect(actionRequestArgsSchemas[kind]).toBeDefined();
    }
    expect(
      actionRequestArgsSchemas.pr_approve.safeParse({ pr: 7, projectId: 'x' })
        .success,
    ).toBe(false);
  });

  it('refuses self-approval of a non-tool request unless admin', () => {
    const own = { requestedById: 'u1', userId: 'u1' };
    expect(
      mayDecideActionRequest({
        kind: 'orchestrator_start',
        ...own,
        isAdmin: false,
      }),
    ).toBe(false);
    expect(
      mayDecideActionRequest({
        kind: 'orchestrator_start',
        ...own,
        isAdmin: true,
      }),
    ).toBe(true);
    expect(
      mayDecideActionRequest({ kind: 'tool_use', ...own, isAdmin: false }),
    ).toBe(true);
    expect(
      mayDecideActionRequest({
        kind: 'pr_approve',
        requestedById: 'u1',
        userId: 'u2',
        isAdmin: false,
      }),
    ).toBe(true);
    // C-112: a person must queue a session's issue, but may be its requester.
    expect(
      mayDecideActionRequest({ kind: 'issue_queue', ...own, isAdmin: false }),
    ).toBe(true);
  });

  it('accepts the tool input preview fields and rejects an input over the max (C-114)', () => {
    const toolUse = actionRequestArgsSchemas.tool_use;
    const preview = {
      toolName: 'Bash',
      input: 'x'.repeat(ACTION_REQUEST_TOOL_INPUT_MAX),
      truncated: true,
      fullLength: 2_048,
      sha256: 'a'.repeat(64),
    };
    expect(toolUse.safeParse(preview).success).toBe(true);
    expect(
      toolUse.safeParse({ toolName: 'Bash', preview: 'none' }).success,
    ).toBe(true);
    expect(
      toolUse.safeParse({
        ...preview,
        input: 'x'.repeat(ACTION_REQUEST_TOOL_INPUT_MAX + 1),
      }).success,
    ).toBe(false);
    expect(toolUse.safeParse({ ...preview, sha256: 'nope' }).success).toBe(
      false,
    );
    expect(toolUse.safeParse({ ...preview, preview: 'none' }).success).toBe(
      false,
    );
  });

  it('never lets a session ask for issue_queue itself (C-112)', () => {
    expect(
      localActionRequestArgsSchema.safeParse({
        kind: 'issue_queue',
        args: { issue: 1, title: 't', url: 'https://x/1', session: null },
        summary: 'queue it',
      }).success,
    ).toBe(false);
  });
});

describe('the manual terminal target (spec 201 D23)', () => {
  const target = {
    kind: 'manual',
    projectId: 'prj_1',
    root: '/home/u/dev/app',
    sessionId: '0c9e2f4a',
  };

  it('parses on its own', () => {
    expect(manualTerminalTargetSchema.safeParse(target).success).toBe(true);
  });

  it('is a kind the attach command accepts', () => {
    expect(terminalTargetSchema.safeParse(target).success).toBe(true);
  });
});

describe('card.track title (C-131)', () => {
  it('is one line', () => {
    expect(parseLocalRequest('card.track', { title: 'Fix it' }).ok).toBe(true);
    for (const title of ['Fix it\n## How to work', 'Fix it\r\nnow']) {
      expect(parseLocalRequest('card.track', { title }).ok).toBe(false);
    }
  });
});
