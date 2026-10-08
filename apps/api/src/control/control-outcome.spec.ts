import type { CommandErrorCode } from '@agentdock/shared/protocol';
import { controlOutcome } from './control-outcome';

const error = (code: CommandErrorCode, message?: string) =>
  controlOutcome('slot.stop', { status: 'error', error: { code, message } });

const summary = (outcome: ReturnType<typeof error>) =>
  outcome.status === 'ok'
    ? ['ok']
    : [outcome.status, outcome.failure.statusCode, outcome.failure.code];

describe('controlOutcome', () => {
  it('passes a result through', () => {
    expect(
      controlOutcome('slot.stop', { status: 'ok', output: { stopped: true } }),
    ).toEqual({ status: 'ok', output: { stopped: true } });
  });

  it('leaves the run unknown with 504 when the runner never answered', () => {
    expect(summary(controlOutcome('slot.stop', { status: 'unknown' }))).toEqual(
      ['unknown', 504, 'runner_timeout'],
    );
  });

  it.each([
    ['already_running', 409, 'already_running'],
    ['unknown_profile', 422, 'unknown_profile'],
    ['unsupported_runtime', 422, 'unsupported_runtime'],
    ['path_not_allowed', 403, 'path_not_allowed'],
    ['timeout', 504, 'runner_timeout'],
    ['invalid_args', 502, 'runner_error'],
    ['path_not_found', 502, 'runner_error'],
    ['disabled', 502, 'runner_error'],
    ['internal', 502, 'runner_error'],
  ] as const)('maps %s to %i %s, the run ending error', (code, status, mapped) => {
    expect(summary(error(code))).toEqual(['error', status, mapped]);
  });

  it('keeps the runner code in a 502 message', () => {
    const outcome = error('disabled', 'disabledCommands lists it');
    expect(outcome.status === 'error' && outcome.failure.message).toBe(
      'slot.stop: disabled — disabledCommands lists it',
    );
  });
});
