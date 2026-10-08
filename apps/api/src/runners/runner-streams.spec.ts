import type { LiveConnection, RunnerConnections } from './runner-connections';
import { type RunnerStreamListener, RunnerStreams } from './runner-streams';

const connection = (runnerId: string) =>
  ({ runnerId, send: jest.fn(() => true) }) as unknown as LiveConnection;

const listener = () => {
  const calls: string[] = [];
  const l: RunnerStreamListener = {
    name: 'test',
    connected: (id) => calls.push(`connected ${id}`),
    disconnected: (id) => calls.push(`disconnected ${id}`),
    message: (id, m) => calls.push(`${m.type} ${id} ${m.id}`),
  };
  return { l, calls };
};

describe('RunnerStreams', () => {
  const connections = { get: jest.fn() };
  const streams = () =>
    new RunnerStreams(connections as unknown as RunnerConnections);

  it('sends on the open connection, and reports an offline runner', () => {
    const live = connection('r1');
    connections.get.mockReturnValueOnce(live).mockReturnValueOnce(undefined);
    const s = streams();
    expect(s.send('r1', { type: 'unsubscribe', id: 'p1' })).toBe(true);
    expect(live.send).toHaveBeenCalledWith({ type: 'unsubscribe', id: 'p1' });
    expect(s.send('r1', { type: 'unsubscribe', id: 'p1' })).toBe(false);
  });

  it('ignores the close of a socket that a newer one already replaced', () => {
    const s = streams();
    const { l, calls } = listener();
    s.register(l);
    const old = connection('r1');
    const fresh = connection('r1');
    s.connected(old);
    s.connected(fresh);
    s.disconnected(old);
    s.disconnected(fresh);
    s.disconnected(fresh);
    expect(calls).toEqual(['connected r1', 'connected r1', 'disconnected r1']);
  });

  it('delivers messages to every listener, past one that throws', () => {
    const s = streams();
    const { l, calls } = listener();
    s.register({
      ...l,
      message: () => {
        throw new Error('boom');
      },
    });
    s.register(l);
    s.deliver('r1', { type: 'subscribe.error', id: 'p1', code: 'not_found' });
    expect(calls).toEqual(['subscribe.error r1 p1']);
  });
});
