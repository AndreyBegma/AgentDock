import {
  TERMINAL_CLOSE_CODES,
  type TerminalServerFrame,
} from '@agentdock/shared';
import {
  TERMINAL_MAX_DATA_BYTES,
  type TerminalAttachArgs,
  type TerminalMode,
  type TerminalTarget,
} from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import type { AuditEntry } from '../audit/audit.types';
import type { AuthContext } from '../auth';
import type { TerminalOptions } from './terminal-options';
import {
  type TerminalAttach,
  type TerminalBrowser,
  TerminalRelay,
} from './terminal-relay';
import type {
  TerminalAttachOutcome,
  TerminalRunnerPort,
  TerminalToRunner,
} from './terminal-runner-port';

const IDLE_MS = 1_000;
const MAX_MS = 10_000;
const SECRET = 'hunter2-secret-keystrokes';

const options: TerminalOptions = {
  ticketTtlMs: 30_000,
  idleTimeoutMs: IDLE_MS,
  maxDurationMs: MAX_MS,
  revalidateMs: 60_000,
};

const slotTarget: TerminalTarget = {
  kind: 'slot',
  projectId: 'p1',
  root: '/srv/repo',
  slot: 'i42',
};

class FakeRunner implements TerminalRunnerPort {
  readonly sent: { runnerId: string; message: TerminalToRunner }[] = [];
  readonly attaches: TerminalAttachArgs[] = [];
  online = true;
  private answers: ((o: TerminalAttachOutcome) => void)[] = [];
  /** When set, `attach` answers at once; otherwise call `answer`. */
  auto: TerminalAttachOutcome | null = { status: 'ok', session: 'cs-i42' };

  attach(
    _runnerId: string,
    args: TerminalAttachArgs,
  ): Promise<TerminalAttachOutcome> {
    this.attaches.push(args);
    if (this.auto) return Promise.resolve(this.auto);
    return new Promise((resolve) => this.answers.push(resolve));
  }

  answer(outcome: TerminalAttachOutcome): void {
    this.answers.shift()?.(outcome);
  }

  send(runnerId: string, message: TerminalToRunner): boolean {
    if (!this.online) return false;
    this.sent.push({ runnerId, message });
    return true;
  }

  of(type: TerminalToRunner['type']) {
    return this.sent.map((s) => s.message).filter((m) => m.type === type);
  }
}

class FakeBrowser implements TerminalBrowser {
  readonly data: Buffer[] = [];
  readonly frames: TerminalServerFrame[] = [];
  closed: { code: number; reason: string } | null = null;

  sendData(bytes: Buffer): void {
    this.data.push(bytes);
  }

  sendFrame(frame: TerminalServerFrame): void {
    this.frames.push(frame);
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }
}

describe('TerminalRelay', () => {
  let runner: FakeRunner;
  let audits: AuditEntry[];
  let session: AuthContext | null;
  let relay: TerminalRelay;
  let logs: string[];

  const flush = () => jest.advanceTimersByTimeAsync(0);

  const open = async (
    mode: TerminalMode = 'read',
    user = { id: 'u1', email: 'ada@example.com' },
    target: TerminalTarget = slotTarget,
  ): Promise<{ attach: TerminalAttach | null; browser: FakeBrowser }> => {
    const browser = new FakeBrowser();
    const attach = relay.open({
      grant: {
        ticketId: `ticket-${user.id}-${mode}`,
        userId: user.id,
        sessionId: 's1',
        runnerId: 'r1',
        target,
        mode,
      },
      user,
      sessionToken: 'cookie',
      origin: { ip: '127.0.0.1' },
      cols: 100,
      rows: 30,
      browser,
    });
    await flush();
    return { attach, browser };
  };

  const detached = () => audits.filter((a) => a.action === 'terminal.detached');

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
    runner = new FakeRunner();
    audits = [];
    session = {
      user: {
        id: 'u1',
        role: 'admin',
        email: 'ada@example.com',
      } as AuthContext['user'],
      sessionId: 's1',
    };
    logs = [];
    for (const level of ['log', 'debug', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(' '));
        });
    }
    relay = new TerminalRelay(
      runner,
      {
        record: async (entry: AuditEntry) => {
          audits.push(entry);
        },
      },
      { resolve: async () => session },
      options,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('attach', () => {
    it('sends terminal.attach with the target, mode and size, and tells the browser', async () => {
      const { attach, browser } = await open('read');
      expect(runner.attaches).toEqual([
        {
          id: attach?.id,
          target: slotTarget,
          mode: 'read',
          cols: 100,
          rows: 30,
        },
      ]);
      expect(browser.frames).toEqual([
        { type: 'attached', id: attach?.id, mode: 'read', session: 'cs-i42' },
      ]);
      expect(audits).toEqual([
        expect.objectContaining({
          action: 'terminal.attached',
          result: 'ok',
          projectId: 'p1',
          target: { type: 'slot', id: 'i42' },
          actor: { type: 'user', userId: 'u1' },
          after: {
            target: {
              kind: 'slot',
              projectId: 'p1',
              slot: 'i42',
              runId: null,
            },
            mode: 'read',
            session: 'cs-i42',
          },
          meta: { ticketId: 'ticket-u1-read', streamId: attach?.id },
        }),
      ]);
    });

    it('closes the browser with the runner refusal and audits it', async () => {
      runner.auto = { status: 'error', code: 'not_found' };
      const { browser } = await open('read');
      expect(browser.frames).toEqual([{ type: 'error', code: 'not_found' }]);
      expect(browser.closed?.code).toBe(TERMINAL_CLOSE_CODES.notFound);
      expect(audits).toEqual([
        expect.objectContaining({
          action: 'terminal.attached',
          result: 'error',
          meta: expect.objectContaining({ refusal: 'not_found' }),
        }),
      ]);
      expect(relay.active('p1')).toEqual([]);
    });

    it('maps disabled to the unsupported close code with its own frame code', async () => {
      runner.auto = { status: 'error', code: 'disabled' };
      const { browser } = await open('read');
      expect(browser.frames).toEqual([{ type: 'error', code: 'disabled' }]);
      expect(browser.closed?.code).toBe(TERMINAL_CLOSE_CODES.unsupported);
    });

    it('on no answer, closes as runner_unavailable and still tells the runner to let go', async () => {
      runner.auto = { status: 'unknown' };
      const { attach, browser } = await open('read');
      expect(browser.closed?.code).toBe(TERMINAL_CLOSE_CODES.runnerUnavailable);
      expect(runner.of('terminal.close')).toEqual([
        { type: 'terminal.close', id: attach?.id, reason: 'client' },
      ]);
    });

    it('a browser that leaves while the runner attaches gets the runner detached and both records', async () => {
      runner.auto = null;
      const { attach } = await open('write');
      if (!attach) throw new Error('no attach');
      await relay.detach(attach);
      expect(audits).toEqual([]);
      runner.answer({ status: 'ok', session: 'cs-i42' });
      await flush();
      expect(runner.of('terminal.close')).toEqual([
        { type: 'terminal.close', id: attach.id, reason: 'client' },
      ]);
      expect(audits.map((a) => a.action)).toEqual([
        'terminal.attached',
        'terminal.detached',
      ]);
    });

    it('a second write attach to the same target is busy and names the holder', async () => {
      await open('write', { id: 'u1', email: 'ada@example.com' });
      const second = await open('write', {
        id: 'u2',
        email: 'bob@example.com',
      });
      expect(second.attach).toBeNull();
      expect(second.browser.frames).toEqual([
        {
          type: 'error',
          code: 'busy',
          heldBy: { id: 'u1', email: 'ada@example.com' },
        },
      ]);
      expect(second.browser.closed?.code).toBe(TERMINAL_CLOSE_CODES.busy);
      expect(runner.attaches).toHaveLength(1);
      expect(audits.at(-1)).toEqual(
        expect.objectContaining({
          action: 'terminal.attached',
          result: 'denied',
          actor: { type: 'user', userId: 'u2' },
        }),
      );
      // Read-only next to it, and write on another target, are fine.
      expect(
        (await open('read', { id: 'u2', email: 'b' })).attach,
      ).not.toBeNull();
      expect(
        (
          await open(
            'write',
            { id: 'u2', email: 'b' },
            { ...slotTarget, slot: 'i43' },
          )
        ).attach,
      ).not.toBeNull();
    });

    it('lists the live attaches of a project and the write holder', async () => {
      const { attach } = await open('write');
      expect(relay.active('p1')).toEqual([
        {
          id: attach?.id,
          target: { kind: 'slot', projectId: 'p1', slot: 'i42', runId: null },
          mode: 'write',
          user: { id: 'u1', email: 'ada@example.com' },
          since: new Date(0).toISOString(),
        },
      ]);
      expect(relay.active('p2')).toEqual([]);
      expect(relay.writeHolder(slotTarget)).toEqual({
        id: 'u1',
        email: 'ada@example.com',
      });
    });
  });

  describe('bytes', () => {
    it('drops every input byte of a read attach — none reaches the runner', async () => {
      const { attach } = await open('read');
      if (!attach) throw new Error('no attach');
      relay.input(attach, Buffer.from('rm -rf /\r'));
      expect(runner.of('terminal.data')).toEqual([]);
      expect(attach.droppedIn).toBe(9);
      expect(attach.bytesIn).toBe(0);
    });

    it('drops input that arrives before the runner attached', async () => {
      runner.auto = null;
      const { attach } = await open('write');
      if (!attach) throw new Error('no attach');
      relay.input(attach, Buffer.from('ls\r'));
      expect(runner.of('terminal.data')).toEqual([]);
      runner.answer({ status: 'ok', session: 'cs-i42' });
      await flush();
      relay.input(attach, Buffer.from('ls\r'));
      expect(runner.of('terminal.data')).toHaveLength(1);
    });

    it('forwards write input as base64, in chunks of at most 64 KiB', async () => {
      const { attach } = await open('write');
      if (!attach) throw new Error('no attach');
      relay.input(attach, Buffer.from('ls\r'));
      const big = Buffer.alloc(TERMINAL_MAX_DATA_BYTES + 10, 'a');
      relay.input(attach, big);
      const data = runner.of('terminal.data');
      expect(data[0]).toEqual({
        type: 'terminal.data',
        id: attach.id,
        b64: Buffer.from('ls\r').toString('base64'),
      });
      expect(
        data
          .slice(1)
          .map((m) =>
            m.type === 'terminal.data'
              ? Buffer.from(m.b64, 'base64').length
              : 0,
          ),
      ).toEqual([TERMINAL_MAX_DATA_BYTES, 10]);
      expect(attach.bytesIn).toBe(3 + big.length);
    });

    it('relays output of its own runner only', async () => {
      const { attach, browser } = await open('read');
      if (!attach) throw new Error('no attach');
      const b64 = Buffer.from('$ ').toString('base64');
      relay.fromRunner('r1', { type: 'terminal.data', id: attach.id, b64 });
      relay.fromRunner('r2', { type: 'terminal.data', id: attach.id, b64 });
      relay.fromRunner('r1', { type: 'terminal.data', id: 'term_other', b64 });
      expect(browser.data).toEqual([Buffer.from('$ ')]);
      expect(attach.bytesOut).toBe(2);
    });

    it('forwards a resize', async () => {
      const { attach } = await open('read');
      if (!attach) throw new Error('no attach');
      relay.resize(attach, 120, 40);
      expect(runner.of('terminal.resize')).toEqual([
        { type: 'terminal.resize', id: attach.id, cols: 120, rows: 40 },
      ]);
    });
  });

  describe('ending', () => {
    it('detach closes it on the runner and the browser, and audits duration and byte counts', async () => {
      const { attach, browser } = await open('write');
      if (!attach) throw new Error('no attach');
      relay.input(attach, Buffer.from(SECRET));
      relay.fromRunner('r1', {
        type: 'terminal.data',
        id: attach.id,
        b64: Buffer.from(`${SECRET}\r\n`).toString('base64'),
      });
      await jest.advanceTimersByTimeAsync(250);
      await relay.detach(attach);
      expect(runner.of('terminal.close')).toEqual([
        { type: 'terminal.close', id: attach.id, reason: 'client' },
      ]);
      expect(browser.frames.at(-1)).toEqual({
        type: 'closed',
        reason: 'client',
      });
      expect(browser.closed).toEqual({
        code: TERMINAL_CLOSE_CODES.ended,
        reason: 'client',
      });
      expect(detached()).toEqual([
        expect.objectContaining({
          result: 'ok',
          after: {
            reason: 'client',
            durationMs: 250,
            bytesIn: SECRET.length,
            bytesOut: SECRET.length + 2,
          },
        }),
      ]);
      expect(relay.active('p1')).toEqual([]);
    });

    it('never puts terminal bytes in an audit record or a log line', async () => {
      const { attach } = await open('write');
      if (!attach) throw new Error('no attach');
      const b64 = Buffer.from(SECRET).toString('base64');
      relay.input(attach, Buffer.from(SECRET));
      relay.fromRunner('r1', { type: 'terminal.data', id: attach.id, b64 });
      relay.fromRunner('r9', { type: 'terminal.data', id: attach.id, b64 });
      await relay.detach(attach);
      const everything = JSON.stringify(audits) + logs.join('\n');
      expect(logs.length).toBeGreaterThan(0);
      expect(everything).not.toContain(SECRET);
      expect(everything).not.toContain(b64);
    });

    it('a write attach without input for the idle timeout closes with idle — output does not keep it alive', async () => {
      const { attach, browser } = await open('write');
      if (!attach) throw new Error('no attach');
      await jest.advanceTimersByTimeAsync(IDLE_MS / 2);
      relay.input(attach, Buffer.from('x'));
      await jest.advanceTimersByTimeAsync(IDLE_MS / 2);
      relay.fromRunner('r1', {
        type: 'terminal.data',
        id: attach.id,
        b64: Buffer.from('out').toString('base64'),
      });
      await jest.advanceTimersByTimeAsync(IDLE_MS / 2 - 1);
      expect(browser.closed).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      expect(browser.closed).toEqual({
        code: TERMINAL_CLOSE_CODES.ended,
        reason: 'idle',
      });
      expect(runner.of('terminal.close')).toEqual([
        { type: 'terminal.close', id: attach.id, reason: 'idle' },
      ]);
      expect(detached()[0]?.after).toEqual(
        expect.objectContaining({ reason: 'idle' }),
      );
    });

    it('a read attach stays while there is traffic either way, and idles without', async () => {
      const { attach, browser } = await open('read');
      if (!attach) throw new Error('no attach');
      for (let i = 0; i < 3; i += 1) {
        await jest.advanceTimersByTimeAsync(IDLE_MS - 1);
        relay.fromRunner('r1', {
          type: 'terminal.data',
          id: attach.id,
          b64: Buffer.from('tick').toString('base64'),
        });
      }
      expect(browser.closed).toBeNull();
      await jest.advanceTimersByTimeAsync(IDLE_MS);
      expect(browser.closed?.reason).toBe('idle');
    });

    it('closes with max_duration however busy it is', async () => {
      const { attach, browser } = await open('write');
      if (!attach) throw new Error('no attach');
      for (let t = 0; t < MAX_MS; t += IDLE_MS / 2) {
        relay.input(attach, Buffer.from('x'));
        await jest.advanceTimersByTimeAsync(IDLE_MS / 2);
      }
      expect(browser.closed?.reason).toBe('max_duration');
      expect(detached()[0]?.after).toEqual(
        expect.objectContaining({ reason: 'max_duration', durationMs: MAX_MS }),
      );
    });

    it('a terminal.close from the runner ends it with its reason, not echoed back', async () => {
      const { attach, browser } = await open('read');
      if (!attach) throw new Error('no attach');
      relay.fromRunner('r1', {
        type: 'terminal.close',
        id: attach.id,
        reason: 'session_ended',
      });
      await flush();
      expect(browser.closed?.reason).toBe('session_ended');
      expect(runner.of('terminal.close')).toEqual([]);
      expect(detached()[0]?.after).toEqual(
        expect.objectContaining({ reason: 'session_ended' }),
      );
    });

    it("the runner's socket going away ends its attaches with socket", async () => {
      const { attach, browser } = await open('read');
      const other = await open('read', undefined, {
        kind: 'orchestrator',
        projectId: 'p1',
        root: '/srv/repo',
      });
      relay.disconnected('r2');
      expect(browser.closed).toBeNull();
      relay.disconnected('r1');
      await flush();
      expect(browser.closed?.reason).toBe('socket');
      expect(other.browser.closed?.reason).toBe('socket');
      expect(runner.of('terminal.close')).toEqual([]);
      expect(detached()).toHaveLength(2);
      expect(relay.active('p1')).toEqual([]);
      expect(attach?.state).toBe('closed');
    });

    it('a revoked session ends the attach as client, with the cause', async () => {
      const { browser } = await open('write');
      await relay.revalidate();
      expect(browser.closed).toBeNull();
      session = null;
      await relay.revalidate();
      expect(browser.closed?.reason).toBe('client');
      expect(detached()[0]?.meta).toEqual(
        expect.objectContaining({ cause: 'session_revoked' }),
      );
    });

    it('an admin demoted mid-attach is ended too', async () => {
      const { browser } = await open('write');
      if (!session) throw new Error('no session');
      session = {
        ...session,
        user: { ...session.user, role: 'operator' },
      };
      await relay.revalidate();
      expect(browser.closed?.reason).toBe('client');
    });

    it('ends once, however many paths close it', async () => {
      const { attach } = await open('write');
      if (!attach) throw new Error('no attach');
      await relay.detach(attach);
      await relay.detach(attach);
      relay.fromRunner('r1', {
        type: 'terminal.close',
        id: attach.id,
        reason: 'session_ended',
      });
      relay.disconnected('r1');
      await flush();
      expect(detached()).toHaveLength(1);
      expect(runner.of('terminal.close')).toHaveLength(1);
    });

    it('the API shutting down ends every attach with socket and audits it', async () => {
      await open('read');
      await open('write');
      await relay.onModuleDestroy();
      expect(
        detached().map((a) => (a.after as { reason: string }).reason),
      ).toEqual(['socket', 'socket']);
      expect(runner.of('terminal.close')).toHaveLength(2);
    });
  });
});
