import { describe, expect, it } from 'bun:test';
import { SESSION_MESSAGE_MAX_CHARS } from '@nautelle/shared';
import { ApiError } from '../api';
import { draftProblem, sessionMessageError } from './format';

describe('draftProblem (#489)', () => {
  it('is empty when only control characters or spaces are left', () => {
    expect(draftProblem('')).toBe('empty');
    expect(draftProblem('  \n\t')).toBe('empty');
    expect(draftProblem('\u001b[A\u0003')).toBe('empty');
    expect(draftProblem('go on')).toBeNull();
  });

  it('is too long over the cap', () => {
    expect(draftProblem('x'.repeat(SESSION_MESSAGE_MAX_CHARS))).toBeNull();
    expect(draftProblem('x'.repeat(SESSION_MESSAGE_MAX_CHARS + 1))).toBe(
      'too_long',
    );
  });
});

describe('sessionMessageError', () => {
  it('says what a refusal means', () => {
    expect(
      sessionMessageError(new ApiError(403, undefined, 'Forbidden', undefined)),
    ).toBe('Messaging a session needs the operator role.');
    expect(
      sessionMessageError(
        new ApiError(503, undefined, 'x', undefined, {
          error: 'command_unavailable',
        }),
      ),
    ).toContain('runner is offline');
    expect(sessionMessageError(new Error('boom'))).toBe('boom');
  });

  it("#913: names the runner's policy and the line that lifts it", () => {
    const message =
      "refused by this runner's policy (commands): session.message is off on this runner. On the runner's machine: `nautelle-runner policy set commands.session.message true`";
    expect(
      sessionMessageError(
        new ApiError(403, undefined, message, undefined, {
          error: 'policy_refused',
          message,
        }),
      ),
    ).toBe(
      'The runner’s local security policy refused this (Messages into running sessions): session.message is off on this runner. To allow it, run `nautelle-runner policy set commands.session.message true` on that machine.',
    );
  });
});
