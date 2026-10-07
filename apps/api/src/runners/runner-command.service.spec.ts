import type { HttpException } from '@nestjs/common';
import type { WebSocket } from 'ws';
import type { AuditService } from '../audit/audit.service';
import type { AuditContext, AuditEntry } from '../audit/audit.types';
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
  const audit = { record: jest.fn<Promise<void>, [AuditEntry]>() };
  audit.record.mockResolvedValue(undefined);
  const service = new RunnerCommandService(
    connections,
    audit as unknown as AuditService,
  );
  const { socket, sent } = fakeSocket();
  const live = new LiveConnection('rn_1', socket, Date.now());
  connections.attach(live);
  return { service, live, sent, audit };
};

const ctx: AuditContext = { actor: { type: 'user', userId: 'u_1' } };

/** Lets the `requested` record settle, so the command is on the socket. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const recorded = (audit: ReturnType<typeof setup>['audit']) =>
  audit.record.mock.calls.map(([entry]) => [entry.action, entry.result]);

const status = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: HttpException) => error.getStatus(),
  );

describe('RunnerCommandService', () => {
  it('refuses a command outside the allowlist or with invalid args', async () => {
    const { service, sent, audit } = setup();
    await expect(
      status(
        service.send(
          'rn_1',
          'shell.exec' as 'runner.ping',
          {},
          { role: 'admin', ctx },
        ),
      ),
    ).resolves.toBe(400);
    await expect(
      status(
        service.send('rn_1', 'runner.ping', { x: 1 }, { role: 'admin', ctx }),
      ),
    ).resolves.toBe(400);
    expect(sent).toEqual([]);
    // Input validation, not an action: nothing is recorded.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a caller below the command minimum role', async () => {
    const { service, audit } = setup();
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
            ctx,
            timeoutMs: 10,
          },
        ),
      ),
    ).resolves.toBe(403);
    expect(recorded(audit)).toEqual([['runner.command', 'denied']]);
  });

  it('is unknown at once for a runner with no socket', async () => {
    const { service, audit } = setup();
    await expect(
      service.send('rn_other', 'runner.ping', {}, { role: 'viewer', ctx }),
    ).resolves.toEqual({ status: 'unknown' });
    expect(recorded(audit)).toEqual([
      ['runner.command', 'requested'],
      ['runner.command.result', 'error'],
    ]);
  });

  it('resolves with the validated result', async () => {
    const { service, live, sent, audit } = setup();
    const pending = service.send(
      'rn_1',
      'runner.ping',
      {},
      { role: 'viewer', ctx },
    );
    await flush();
    // Recorded before the command reached the socket (spec 8 D8).
    expect(recorded(audit)).toEqual([['runner.command', 'requested']]);
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
    expect(recorded(audit)).toEqual([
      ['runner.command', 'requested'],
      ['runner.command.result', 'ok'],
    ]);
  });

  it('turns a malformed result into an internal error', async () => {
    const { service, live, sent } = setup();
    const pending = service.send(
      'rn_1',
      'runner.ping',
      {},
      { role: 'viewer', ctx },
    );
    await flush();
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
        ctx,
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
    const pending = service.send(
      'rn_1',
      'runner.ping',
      {},
      { role: 'viewer', ctx },
    );
    await flush();
    live.lostAll();
    await expect(pending).resolves.toEqual({ status: 'unknown' });
  });
});
