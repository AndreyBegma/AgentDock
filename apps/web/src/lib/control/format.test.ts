import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api';
import {
  commandRunIdOf,
  describeControlError,
  describeControlErrorHint,
  describeMessageSize,
  describeOutcome,
  MESSAGE_MAX_BYTES,
  MODE_LABEL,
  messageProblem,
  permissionModesFor,
  utf8ByteLength,
} from './format';

const apiError = (status: number, code?: string) =>
  new ApiError(status, code as never, 'server text');

describe('utf8ByteLength / messageProblem', () => {
  test('counts bytes, not characters', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('привет')).toBe(12);
    expect(utf8ByteLength('🙂')).toBe(4);
  });

  test('a blank message is a problem', () => {
    expect(messageProblem('  \n')).toBe('blank');
  });

  test('the limit is inclusive, in bytes', () => {
    expect(messageProblem('a'.repeat(MESSAGE_MAX_BYTES))).toBeNull();
    expect(messageProblem('a'.repeat(MESSAGE_MAX_BYTES + 1))).toBe('too_long');
    // 8193 two-byte characters are 16386 bytes though only 8193 characters.
    expect(messageProblem('я'.repeat(MESSAGE_MAX_BYTES / 2 + 1))).toBe(
      'too_long',
    );
  });

  test('the size hint reads in bytes below 1 KB, never "0 KB"', () => {
    expect(describeMessageSize('hello')).toBe('5 B of 16 KB');
  });

  test('the size hint reads in KB', () => {
    expect(describeMessageSize('a'.repeat(1536))).toBe('1.5 KB of 16 KB');
  });
});

describe('permissionModesFor', () => {
  test('bypassPermissions is offered to admins only', () => {
    expect(permissionModesFor(false)).not.toContain('bypassPermissions');
    expect(permissionModesFor(true)).toContain('bypassPermissions');
  });
});

describe('describeControlError', () => {
  test.each([
    ['runner_offline', 409, 'offline'],
    ['runner_timeout', 504, 'did not answer'],
    ['already_running', 409, 'already running'],
    ['unknown_profile', 422, 'not available'],
    ['unsupported_runtime', 422, 'Codex'],
    ['no_profile', 422, 'No runtime profile'],
    ['path_not_allowed', 403, 'does not belong'],
    ['runner_error', 502, 'failed to carry'],
    ['invalid_args', 400, 'invalid'],
    ['forbidden', 403, 'role'],
  ])('%s', (code, status, fragment) => {
    expect(describeControlError(apiError(status, code))).toContain(fragment);
  });

  test('an unmapped 403 is still a role sentence, not the server text', () => {
    expect(describeControlError(apiError(403))).toContain('role');
  });

  test('a network failure is not an ApiError', () => {
    expect(describeControlError(new TypeError('fetch failed'))).toBe(
      'Could not reach the server.',
    );
  });
});

describe('describeControlErrorHint', () => {
  test('runner offline says how to start it and links admins to Runners', () => {
    const hint = describeControlErrorHint(apiError(409, 'runner_offline'), {
      isAdmin: true,
    });
    expect(hint.text).toContain('agentdock-runner run');
    expect(hint.href).toBe('/admin/runners');
    expect(hint.cta).toBe('Open Runners');
  });

  test('runner offline has no link for a non-admin', () => {
    const hint = describeControlErrorHint(apiError(409, 'runner_offline'));
    expect(hint.href).toBeUndefined();
    expect(hint.cta).toBeUndefined();
  });

  test('no profile links to this project’s orchestrator settings', () => {
    const hint = describeControlErrorHint(apiError(422, 'no_profile'), {
      projectId: 'p1',
    });
    expect(hint.href).toBe('/projects/p1/settings?tab=orchestrator');
  });

  test('a runner failure carries the server message', () => {
    expect(
      describeControlErrorHint(apiError(502, 'runner_error')).text,
    ).toContain('server text');
  });

  test('the string helper is the hint’s text', () => {
    const error = apiError(409, 'runner_offline');
    expect(describeControlError(error)).toBe(
      describeControlErrorHint(error).text,
    );
  });
});

describe('MODE_LABEL', () => {
  test('start and next read the same everywhere, without board jargon', () => {
    expect(MODE_LABEL.start).toContain('new round');
    expect(MODE_LABEL.next).toContain('next queued issue');
    expect(`${MODE_LABEL.start}${MODE_LABEL.next}`.toLowerCase()).not.toContain(
      'board',
    );
  });
});

describe('commandRunIdOf', () => {
  test('reads the run id the API put in the error body', () => {
    const error = new ApiError(409, undefined, 'x', undefined, {
      commandRunId: 'run_1',
    });
    expect(commandRunIdOf(error)).toBe('run_1');
  });

  test('is undefined without a body, an id, or an ApiError', () => {
    expect(commandRunIdOf(apiError(409, 'already_running'))).toBeUndefined();
    expect(commandRunIdOf(new Error('x'))).toBeUndefined();
  });
});

describe('describeOutcome', () => {
  const run = (over: Record<string, unknown>) =>
    ({
      command: 'slot.message',
      slot: 'i42',
      status: 'ok',
      error: null,
      result: { written: true, delivered: true },
      ...over,
    }) as Parameters<typeof describeOutcome>[0];

  test('a pending run has no outcome yet', () => {
    expect(describeOutcome(run({ status: 'requested' }))).toBeNull();
  });

  test('delivered: false says the message waits in the file', () => {
    const outcome = describeOutcome(
      run({ result: { written: true, delivered: false } }),
    );
    expect(outcome?.tone).toBe('info');
    expect(outcome?.text).toContain('not live');
  });

  test('delivered: true is a success', () => {
    expect(describeOutcome(run({}))?.tone).toBe('success');
  });

  test('start names the session the runner reported', () => {
    expect(
      describeOutcome(
        run({
          command: 'orchestrator.start',
          slot: null,
          result: { session: 'agentdock-orch-acme-app' },
        }),
      )?.text,
    ).toContain('agentdock-orch-acme-app');
  });

  test('stop warns nothing about workers being killed', () => {
    expect(
      describeOutcome(
        run({
          command: 'orchestrator.stop',
          slot: null,
          result: { stopped: true },
        }),
      )?.text,
    ).toContain('Workers keep running');
  });

  test('an orchestrator message says delivered, or why it was not sent', () => {
    const orchestrator = (result: Record<string, unknown>) =>
      describeOutcome(
        run({ command: 'orchestrator.message', slot: null, result }),
      );
    expect(orchestrator({ delivered: true })).toEqual({
      tone: 'success',
      text: 'Message to the orchestrator delivered.',
    });
    const absent = orchestrator({ delivered: false, reason: 'absent' });
    expect(absent?.tone).toBe('info');
    expect(absent?.text).toContain('not running');
    const prompt = orchestrator({ delivered: false, reason: 'prompt' });
    expect(prompt?.tone).toBe('info');
    expect(prompt?.text).toContain('waiting on a prompt');
  });

  test('a stop of nothing is informational', () => {
    expect(
      describeOutcome(run({ command: 'slot.stop', result: { stopped: false } }))
        ?.tone,
    ).toBe('info');
  });

  test('an error run carries the sentence of its code', () => {
    const outcome = describeOutcome(
      run({ status: 'error', error: { code: 'already_running' } }),
    );
    expect(outcome?.tone).toBe('error');
    expect(outcome?.text).toContain('already running');
  });

  test('a project skill install links the pull request it opened', () => {
    const outcome = describeOutcome(
      run({
        command: 'skill.install',
        slot: null,
        result: {
          path: '.claude/skills/estimate',
          prUrl: 'https://github.com/acme/app/pull/7',
        },
      }),
    );
    expect(outcome?.tone).toBe('success');
    expect(outcome?.text).toContain('https://github.com/acme/app/pull/7');
  });

  test('an unknown run says the outcome is unknown', () => {
    expect(describeOutcome(run({ status: 'unknown' }))?.text).toContain(
      'unknown',
    );
  });
});
