import { RUNNER_CLOSE_CODES } from '@nautelle/shared/protocol';
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
  return { service, connections, live, socket, sent, audit };
};

const pong = (id: string) => ({
  type: 'command.result' as const,
  id,
  ok: true,
  output: { pong: true, ts: '2026-10-07T18:36:20.000Z' },
});

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

  it('records the args as sent unless auditArgs replaces them, and sends them unchanged', async () => {
    const { service, sent, audit } = setup();
    const args = {
      projectId: 'p_1',
      root: '/srv/dev/widget',
      slot: 'i42',
      text: 'a secret plan',
      from: 'op@example.com',
    };
    const auditedArgs = () =>
      audit.record.mock.calls
        .filter(([entry]) => entry.action === 'runner.command')
        .map(([entry]) => (entry.after as { args: unknown }).args);

    void service.send('rn_1', 'slot.message', args, {
      role: 'operator',
      ctx,
      timeoutMs: 10,
    });
    await flush();
    expect(auditedArgs()).toEqual([args]);

    audit.record.mockClear();
    const hashed = { ...args, text: 'sha256:abc' };
    void service.send('rn_1', 'slot.message', args, {
      role: 'operator',
      ctx,
      timeoutMs: 10,
      auditArgs: hashed,
    });
    await flush();
    expect(auditedArgs()).toEqual([hashed]);
    // The runner still gets the real text.
    expect(sent.map((m) => (m as { args?: unknown }).args)).toEqual([
      args,
      args,
    ]);
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
    const { service, connections, sent, audit } = setup();
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
    connections.settle('rn_1', {
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
    const { service, connections, sent } = setup();
    const pending = service.send(
      'rn_1',
      'runner.ping',
      {},
      { role: 'viewer', ctx },
    );
    await flush();
    connections.settle('rn_1', {
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
    const { service, connections, sent } = setup();
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
    // #740 D4: named from the waiter that gave up, so the log can say what.
    expect(connections.settle('rn_1', pong(sent[0].id))).toEqual({
      outcome: 'unawaited',
      name: 'runner.ping',
    });
  });

  it('is unknown at once when the runner is revoked', async () => {
    const { service, connections } = setup();
    const pending = service.send(
      'rn_1',
      'runner.ping',
      {},
      { role: 'viewer', ctx },
    );
    await flush();
    connections.disconnect('rn_1', RUNNER_CLOSE_CODES.unauthorized, 'revoked');
    await expect(pending).resolves.toEqual({ status: 'unknown' });
  });

  describe('a reconnect keeps the waiter (#740 D2)', () => {
    it('settles from the new connection a command sent on the old one', async () => {
      const { service, connections, live, sent } = setup();
      const pending = service.send(
        'rn_1',
        'runner.ping',
        {},
        { role: 'viewer', ctx },
      );
      await flush();
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      live.close(1006, 'gone');
      connections.detach(live);
      await flush();
      expect(settled).toBe(false);

      const next = new LiveConnection('rn_1', fakeSocket().socket, Date.now());
      connections.attach(next);
      expect(connections.settle('rn_1', pong(sent[0].id)).outcome).toBe(
        'settled',
      );
      await expect(pending).resolves.toMatchObject({ status: 'ok' });
      // A resend of the same result (D3) is known, not a stray.
      expect(connections.settle('rn_1', pong(sent[0].id)).outcome).toBe(
        'repeat',
      );
    });

    it('is unknown when the deadline passes before the runner is back', async () => {
      const { service, connections, live } = setup();
      const pending = service.send(
        'rn_1',
        'runner.ping',
        {},
        { role: 'viewer', ctx, timeoutMs: 20 },
      );
      await flush();
      connections.detach(live);
      await expect(pending).resolves.toEqual({ status: 'unknown' });
    });
  });
});
