import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  commands,
  type HelloMessage,
  messageSchema,
  PAIRING_CODE_ALPHABET,
  pairingCodeSchema,
  pairingRequestSchema,
  pairingResponseSchema,
  parseCommand,
  roleAtLeast,
  runnerMessageSchema,
  runnerMessageTypes,
  serverMessageSchema,
  serverMessageTypes,
  spoolTruncatedDataSchema,
  unsequencedEventSchema,
} from './index';

const DOC = join(__dirname, '../../../../docs/architecture/runner-protocol.md');

/** Every ```json block of runner-protocol.md, parsed as JSON. */
const docExamples = (): unknown[] => {
  const markdown = readFileSync(DOC, 'utf8');
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((m) =>
    JSON.parse(m[1]),
  );
};

const typeOf = (message: unknown): string => (message as { type: string }).type;

/** The documented `hello` example, parsed. */
const hello = (): HelloMessage => {
  const example = docExamples().find((m) => typeOf(m) === 'hello');
  const parsed = runnerMessageSchema.parse(example);
  if (parsed.type !== 'hello') throw new Error('no hello example');
  return parsed;
};

describe('runner-protocol.md examples', () => {
  const examples = docExamples();

  it('has examples', () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(
    examples.map((e) => [typeOf(e), e]),
  )('parses the %s example', (_type, example) => {
    const result = messageSchema.safeParse(example);
    expect(result.error).toBeUndefined();
  });

  it('has an example of every message type', () => {
    const documented = new Set(examples.map(typeOf));
    for (const type of [...runnerMessageTypes, ...serverMessageTypes]) {
      expect(documented).toContain(type);
    }
  });

  it('parses each example in its own direction only', () => {
    for (const example of examples) {
      const type = typeOf(example);
      const fromRunner = runnerMessageSchema.safeParse(example).success;
      const fromServer = serverMessageSchema.safeParse(example).success;
      expect([type, fromRunner]).toEqual([
        type,
        (runnerMessageTypes as string[]).includes(type),
      ]);
      expect([type, fromServer]).toEqual([
        type,
        (serverMessageTypes as string[]).includes(type),
      ]);
    }
  });

  it('documents the runner.spool_truncated data shape', () => {
    const events = examples.find((m) => typeOf(m) === 'events') as {
      events: { type: string; data: unknown }[];
    };
    const truncated = events.events.find(
      (e) => e.type === 'runner.spool_truncated',
    );
    expect(spoolTruncatedDataSchema.safeParse(truncated?.data).success).toBe(
      true,
    );
  });
});

describe('messageSchema', () => {
  it('rejects an unknown top-level type', () => {
    expect(messageSchema.safeParse({ type: 'shell.exec' }).success).toBe(false);
    expect(runnerMessageSchema.safeParse({ type: 'welcome' }).success).toBe(
      false,
    );
    expect(serverMessageSchema.safeParse({ type: 'hello' }).success).toBe(
      false,
    );
  });

  it('rejects a message without a type', () => {
    expect(messageSchema.safeParse({ seq: 1 }).success).toBe(false);
  });

  it('ignores unknown fields, so either side can add one', () => {
    const parsed = messageSchema.parse({ type: 'ack', seq: 3, extra: true });
    expect(parsed).toEqual({ type: 'ack', seq: 3 });
  });

  it('accepts a hello where every tool is absent', () => {
    const message = hello();
    const bare = {
      ...message,
      capabilities: {
        tmux: null,
        git: null,
        gh: null,
        runtimes: { claude: null, codex: null },
        profiles: [],
        codeSentinel: null,
        otlp: null,
      },
    };
    expect(messageSchema.safeParse(bare).success).toBe(true);
  });

  it('rejects a negative seq cursor and a zero event seq', () => {
    expect(messageSchema.safeParse({ type: 'ack', seq: -1 }).success).toBe(
      false,
    );
    expect(messageSchema.safeParse({ type: 'ack', seq: 0 }).success).toBe(true);
    const event = {
      v: 1,
      seq: 0,
      ts: '2026-10-07T18:36:02.335Z',
      type: 'x',
      source: 'runner',
      data: {},
    };
    expect(
      messageSchema.safeParse({ type: 'events', events: [event] }).success,
    ).toBe(false);
  });

  it('caps an events batch at 500 and refuses an empty one', () => {
    const event = (seq: number) => ({
      v: 1,
      seq,
      ts: '2026-10-07T18:36:02.335Z',
      type: 'x',
      source: 'runner',
      data: null,
    });
    const batch = (n: number) => ({
      type: 'events',
      events: Array.from({ length: n }, (_, i) => event(i + 1)),
    });
    expect(messageSchema.safeParse(batch(500)).success).toBe(true);
    expect(messageSchema.safeParse(batch(501)).success).toBe(false);
    expect(messageSchema.safeParse(batch(0)).success).toBe(false);
  });

  it('requires error exactly when command.result is not ok', () => {
    const ok = { type: 'command.result', id: 'c', ok: true };
    const failed = {
      type: 'command.result',
      id: 'c',
      ok: false,
      error: { code: 'internal' },
    };
    expect(messageSchema.safeParse(ok).success).toBe(true);
    expect(messageSchema.safeParse(failed).success).toBe(true);
    expect(messageSchema.safeParse({ ...ok, ok: false }).success).toBe(false);
    expect(messageSchema.safeParse({ ...failed, ok: true }).success).toBe(
      false,
    );
    expect(
      messageSchema.safeParse({ ...failed, error: { code: 'boom' } }).success,
    ).toBe(false);
  });

  it('requires an id on command and its replies', () => {
    expect(
      messageSchema.safeParse({
        type: 'command',
        name: 'runner.ping',
        args: {},
      }).success,
    ).toBe(false);
    expect(
      messageSchema.safeParse({ type: 'command.progress', chunk: 'x' }).success,
    ).toBe(false);
  });

  it('parses a command with an unknown name, for the dispatcher to answer', () => {
    const parsed = serverMessageSchema.parse({
      type: 'command',
      id: 'c',
      name: 'shell.exec',
      args: { cmd: 'rm -rf /' },
    });
    expect(parsed.type).toBe('command');
  });
});

describe('unsequencedEventSchema', () => {
  it('accepts a plugin event without seq', () => {
    const event = {
      v: 1,
      ts: '2026-10-07T18:36:02.335Z',
      type: 'orchestrator.started',
      source: 'code-sentinel',
      data: {},
    };
    expect(unsequencedEventSchema.safeParse(event).success).toBe(true);
  });

  it('rejects an unknown source and a non-ISO timestamp', () => {
    const event = {
      v: 1,
      ts: '2026-10-07T18:36:02.335Z',
      type: 'x',
      source: 'runner',
      data: {},
    };
    expect(
      unsequencedEventSchema.safeParse({ ...event, source: 'cron' }).success,
    ).toBe(false);
    expect(
      unsequencedEventSchema.safeParse({ ...event, ts: 'yesterday' }).success,
    ).toBe(false);
  });
});

describe('command allowlist', () => {
  it('validates runner.ping args', () => {
    expect(parseCommand('runner.ping', {})).toEqual({
      ok: true,
      name: 'runner.ping',
      args: {},
    });
    const invalid = parseCommand('runner.ping', { extra: 1 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('invalid_args');
    expect(parseCommand('runner.ping', undefined).ok).toBe(false);
  });

  it('answers unknown_command for a name outside the allowlist', () => {
    for (const name of ['shell.exec', 'toString', '__proto__', 'constructor']) {
      const parsed = parseCommand(name, {});
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe('unknown_command');
    }
  });

  it('describes the runner with the hello capabilities', () => {
    const message = hello();
    const output = {
      runnerVersion: message.runnerVersion,
      hostname: message.hostname,
      os: message.os,
      arch: message.arch,
      capabilities: message.capabilities,
    };
    expect(commands['runner.describe'].result.safeParse(output).success).toBe(
      true,
    );
  });

  it('ranks roles', () => {
    expect(roleAtLeast('admin', 'operator')).toBe(true);
    expect(roleAtLeast('operator', 'operator')).toBe(true);
    expect(roleAtLeast('viewer', 'operator')).toBe(false);
  });
});

describe('pairing', () => {
  it('uses an alphabet without ambiguous characters', () => {
    for (const c of '0O1IL') expect(PAIRING_CODE_ALPHABET).not.toContain(c);
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(
      PAIRING_CODE_ALPHABET.length,
    );
  });

  it('normalizes a typed code and rejects ambiguous or malformed ones', () => {
    expect(pairingCodeSchema.parse(' abcd-ef23 ')).toBe('ABCD-EF23');
    for (const code of ['ABCD-EF2O', 'ABCD-1234', 'ABCDEF23', 'ABC-DEF23']) {
      expect([code, pairingCodeSchema.safeParse(code).success]).toEqual([
        code,
        false,
      ]);
    }
  });

  it('parses the pairing request and response', () => {
    expect(
      pairingRequestSchema.safeParse({
        code: 'ABCD-EF23',
        hostname: 'archi-desktop',
        version: '0.1.0',
        protocolVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      pairingResponseSchema.safeParse({
        runnerId: 'rn_01J9Z6Q4X8',
        token: 'A'.repeat(43),
      }).success,
    ).toBe(true);
    expect(
      pairingResponseSchema.safeParse({ runnerId: 'r', token: 'short' })
        .success,
    ).toBe(false);
  });
});
