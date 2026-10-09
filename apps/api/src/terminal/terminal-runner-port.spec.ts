import type { TerminalAttachArgs } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import type { RunnerCommandService } from '../runners/runner-command.service';
import type { RunnerStreams } from '../runners/runner-streams';
import { RunnerTerminalPort } from './terminal-runner-port';

const args: TerminalAttachArgs = {
  id: 'term_1',
  target: { kind: 'orchestrator', projectId: 'p1', root: '/srv/repo' },
  mode: 'read',
  cols: 80,
  rows: 24,
};
const ctx = { actor: { type: 'user' as const, userId: 'u1' } };

describe('RunnerTerminalPort.attach', () => {
  const port = (send: jest.Mock) =>
    new RunnerTerminalPort(
      { send } as unknown as RunnerCommandService,
      {} as RunnerStreams,
    );

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends terminal.attach as admin with the caller as audit context', async () => {
    const send = jest.fn().mockResolvedValue({
      status: 'ok',
      output: { attached: true, session: 'agentdock-orch' },
      rttMs: 3,
    });
    expect(await port(send).attach('r1', args, { ctx })).toEqual({
      status: 'ok',
      session: 'agentdock-orch',
    });
    expect(send).toHaveBeenCalledWith('r1', 'terminal.attach', args, {
      role: 'admin',
      ctx,
    });
  });

  it('passes a runner error and a missing answer on', async () => {
    const error = jest.fn().mockResolvedValue({
      status: 'error',
      error: { code: 'busy', message: 'cap reached' },
    });
    expect(await port(error).attach('r1', args, { ctx })).toEqual({
      status: 'error',
      code: 'busy',
      message: 'cap reached',
    });
    const unknown = jest.fn().mockResolvedValue({ status: 'unknown' });
    expect(await port(unknown).attach('r1', args, { ctx })).toEqual({
      status: 'unknown',
    });
  });

  it('turns a refusal before sending into an error, never a throw', async () => {
    const send = jest.fn().mockRejectedValue(new Error('invalid args'));
    expect(await port(send).attach('r1', args, { ctx })).toEqual({
      status: 'error',
      code: 'invalid_args',
    });
  });
});
