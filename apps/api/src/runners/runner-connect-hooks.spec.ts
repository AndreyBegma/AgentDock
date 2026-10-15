import { Logger } from '@nestjs/common';
import { RunnerConnectHooks } from './runner-connect-hooks';

describe('RunnerConnectHooks (#329 D4)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs every hook in order with the runner id', async () => {
    const hooks = new RunnerConnectHooks();
    const calls: string[] = [];
    hooks.register({
      name: 'a',
      connected: async (id) => void calls.push(`a:${id}`),
    });
    hooks.register({
      name: 'b',
      connected: async (id) => void calls.push(`b:${id}`),
    });
    await hooks.connected('r1');
    expect(calls).toEqual(['a:r1', 'b:r1']);
  });

  it('a failing hook is logged and never stops the next', async () => {
    const hooks = new RunnerConnectHooks();
    const calls: string[] = [];
    hooks.register({
      name: 'broken',
      connected: async () => {
        throw new Error('db down');
      },
    });
    hooks.register({
      name: 'after',
      connected: async (id) => void calls.push(id),
    });
    await expect(hooks.connected('r1')).resolves.toBeUndefined();
    expect(calls).toEqual(['r1']);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'connect hook broken failed for runner r1',
      expect.any(String),
    );
  });
});
