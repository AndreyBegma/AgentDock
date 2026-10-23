import {
  APPROVALS_ERROR,
  type ApprovalsErrorBody,
  REDACTION_MARKER,
} from '@nautelle/shared';
import type { Role } from '@nautelle/shared/protocol';
import { HttpException } from '@nestjs/common';
import type { RunnerCommandService } from '../runners/runner-command.service';
import { ApprovalCommands, commandFailure } from './approval-commands';
import { inspectionErrorOf } from './approvals-query.service';

const LEAKY =
  "fatal: unable to access 'https://user:tok@github.com/o/r': The requested URL returned error: 403";
const REDACTED = `fatal: unable to access 'https://github.com/o/r ${REDACTION_MARKER}': The requested URL returned error: 403`;

/** A command service whose every send fails with `error`. */
const failingCommands = (error: { code: string; message?: string }) =>
  ({
    send: async () => ({ status: 'error', error }),
  }) as unknown as RunnerCommandService;

const thrown = async (promise: Promise<unknown>): Promise<HttpException> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('expected the command to fail');
};

describe('commandFailure (WI-74)', () => {
  it('redacts URL userinfo in the runner text and marks it', () => {
    expect(
      commandFailure('pr.inspect', { code: 'internal', message: LEAKY }),
    ).toEqual({
      headline: 'pr.inspect failed on the runner: internal',
      detail: REDACTED,
    });
  });

  it('gives a known code its fixed headline plus the redacted detail', () => {
    expect(
      commandFailure('pr.approve', { code: 'timeout', message: LEAKY }),
    ).toEqual({
      headline: 'The runner did not finish in time',
      detail: REDACTED,
    });
  });

  it('has no detail when the runner sent no text', () => {
    expect(commandFailure('pr.inspect', { code: 'not_found' })).toEqual({
      headline: 'The runner could not find the pull request',
    });
  });

  it.each<Role>([
    'viewer',
    'operator',
  ])('returns the redacted text to a %s alike', async (role) => {
    const commands = new ApprovalCommands(
      failingCommands({ code: 'internal', message: LEAKY }),
    );
    const error = await thrown(
      commands.inspect('runner-1', { prNumber: 1 } as never, {
        role,
        ctx: {} as never,
      }),
    );
    const body = error.getResponse() as ApprovalsErrorBody;
    expect(error.getStatus()).toBe(502);
    expect(body.error).toBe(APPROVALS_ERROR.commandFailed);
    expect(body.detail).toBe(REDACTED);
    expect(JSON.stringify(body)).not.toContain('tok@');
    expect(inspectionErrorOf(error)).toEqual({
      code: APPROVALS_ERROR.commandFailed,
      message: 'pr.inspect failed on the runner: internal',
      detail: REDACTED,
    });
  });

  it('redacts an inspection error built from unredacted text', () => {
    expect(
      inspectionErrorOf(
        new HttpException({ error: 'internal', message: LEAKY }, 500),
      ),
    ).toEqual({ code: 'internal', message: REDACTED });
  });
});
