import type { HttpException } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { RunnerCommandService } from './runner-command.service';
import { LiveConnection, RunnerConnections } from './runner-connections';

const OPEN = 1;

/** A socket that records what is sent and stays open. */
const fakeSocket = () => {
  const sent: { id: string; name: string }[] = [];
  const socket = {
    readyState: OPEN,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: jest.fn(),
  };
  return { socket: socket as unknown as WebSocket, sent };
};

const setup = () => {
  const connections = new RunnerConnections();
  const service = new RunnerCommandService(connections);
  const { socket, sent } = fakeSocket();
  const live = new LiveConnection('rn_1', socket, Date.now());
  connections.attach(live);
  return { service, live, sent };
};

const status = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: HttpException) => error.getStatus(),
  );

describe('RunnerCommandService', () => {
  it('refuses a command outside the allowlist or with invalid args', async () => {
    const { service, sent } = setup();
    await expect(
      status(
        service.send(
          'rn_1',
          'shell.exec' as 'runner.ping',
          {},
          { role: 'admin' },
        ),
      ),
    ).resolves.toBe(400);
    await expect(
      status(service.send('rn_1', 'runner.ping', { x: 1 }, { role: 'admin' })),
    ).resolves.toBe(400);
    expect(sent).toEqual([]);
  });

  it('refuses a caller below the command minimum role', async () => {
    const { service } = setup();
    // Every implemented command is viewer+; any role passes. Exercise the check
    // by asking for a role the type system allows but the rank does not.
    await expect(
      status(
        service.send(
          'rn_1',
          'runner.ping',
          {},
          {
            role: 'nobody' as 'viewer',
            timeoutMs: 10,
          },
        ),
      ),
    ).resolves.toBe(403);
  });

  it('is unknown at once for a runner with no socket', async () => {
    const { service } = setup();
    await expect(
      service.send('rn_other', 'runner.ping', {}, { role: 'viewer' }),
    ).resolves.toEqual({ status: 'unknown' });
  });

  it('resolves with the validated result', async () => {
    const { service, live, sent } = setup();
    const pending = service.send('rn_1', 'runner.ping', {}, { role: 'viewer' });
    const ts = '2026-10-07T18:36:20.000Z';
    live.settle({
      type: 'command.result',
      id: sent[0].id,
      ok: true,
      output: { pong: true, ts },
    });
    await expect(pending).resolves.toEqual({
      status: 'ok',
      output: { pong: true, ts },
      rttMs: expect.any(Number),
    });
  });

  it('turns a malformed result into an internal error', async () => {
    const { service, live, sent } = setup();
    const pending = service.send('rn_1', 'runner.ping', {}, { role: 'viewer' });
    live.settle({
      type: 'command.result',
      id: sent[0].id,
      ok: true,
      output: { pong: 'yes' },
    });
    await expect(pending).resolves.toEqual({
      status: 'error',
      error: { code: 'internal', message: 'malformed result' },
    });
  });

  it('is unknown after the timeout, and a late result is ignored', async () => {
    const { service, live, sent } = setup();
    const result = await service.send(
      'rn_1',
      'runner.ping',
      {},
      {
        role: 'viewer',
        timeoutMs: 20,
      },
    );
    expect(result).toEqual({ status: 'unknown' });
    expect(
      live.settle({
        type: 'command.result',
        id: sent[0].id,
        ok: true,
        output: { pong: true, ts: '2026-10-07T18:36:20.000Z' },
      }),
    ).toBe(false);
  });

  it('is unknown at once when the socket is lost', async () => {
    const { service, live } = setup();
    const pending = service.send('rn_1', 'runner.ping', {}, { role: 'viewer' });
    live.lostAll();
    await expect(pending).resolves.toEqual({ status: 'unknown' });
  });
});
