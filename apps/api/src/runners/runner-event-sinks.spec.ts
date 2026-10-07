import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import { type RunnerEventSink, RunnerEventSinks } from './runner-event-sinks';

const event: RunnerEvent = {
  v: 1,
  seq: 1,
  ts: '2026-10-07T18:36:02.335Z',
  type: 'slot.checkpoint',
  source: 'code-sentinel',
  data: {},
};

const sink = (
  name: string,
  calls: string[],
  handle?: () => Promise<void>,
): RunnerEventSink => ({
  name,
  handle: async (runnerId, events) => {
    calls.push(`${name}:${runnerId}:${events.length}`);
    await handle?.();
  },
});

describe('RunnerEventSinks', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs every sink in registration order', async () => {
    const calls: string[] = [];
    const sinks = new RunnerEventSinks();
    sinks.register(sink('sessions', calls));
    sinks.register(sink('fleet', calls));
    await sinks.dispatch('rn_1', [event]);
    expect(calls).toEqual(['sessions:rn_1:1', 'fleet:rn_1:1']);
  });

  it('logs the first throwing sink by name, rethrows, and runs no later sink', async () => {
    const calls: string[] = [];
    const sinks = new RunnerEventSinks();
    sinks.register(
      sink('broken', calls, () => Promise.reject(new Error('db down'))),
    );
    sinks.register(sink('fleet', calls));
    await expect(sinks.dispatch('rn_1', [event])).rejects.toThrow('db down');
    expect(calls).toEqual(['broken:rn_1:1']);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('sink broken failed'),
      expect.stringContaining('db down'),
    );
  });

  it('dispatches with no sinks registered', async () => {
    await expect(
      new RunnerEventSinks().dispatch('rn_1', [event]),
    ).resolves.toBeUndefined();
  });
});
