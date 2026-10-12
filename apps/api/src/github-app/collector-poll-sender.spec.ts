import { SYSTEM_ACTOR } from '../audit/audit.types';
import type { RunnerCommandService } from '../runners/runner-command.service';
import { CollectorPollSender } from './collector-poll-sender';

const ARGS = { projectId: 'prj_1', collectors: ['issues' as const] };

const senderWith = (send: jest.Mock): CollectorPollSender => {
  const sender = new CollectorPollSender();
  // The service is property-injected; stand in for Nest here.
  Reflect.set(sender, 'commands', { send } as unknown as RunnerCommandService);
  return sender;
};

describe('CollectorPollSender (spec 27 D13)', () => {
  it('sends collector.poll as the system actor with the admin role', async () => {
    const send = jest.fn().mockResolvedValue({
      status: 'ok',
      output: { restarted: ['issues'] },
      rttMs: 3,
    });
    expect(await senderWith(send).send('run_1', ARGS)).toBe('sent');
    expect(send).toHaveBeenCalledWith('run_1', 'collector.poll', ARGS, {
      role: 'admin',
      ctx: { actor: SYSTEM_ACTOR },
    });
  });

  it.each([
    ['an offline or silent runner', { status: 'unknown' }],
    ['a runner error', { status: 'error', error: { code: 'internal' } }],
  ])('answers failed for %s', async (_name, result) => {
    const send = jest.fn().mockResolvedValue(result);
    expect(await senderWith(send).send('run_1', ARGS)).toBe('failed');
  });

  it('answers failed, never throws, when the command is refused', async () => {
    const send = jest.fn().mockRejectedValue(new Error('refused'));
    expect(await senderWith(send).send('run_1', ARGS)).toBe('failed');
  });
});
