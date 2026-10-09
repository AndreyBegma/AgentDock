import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service';
import { RunnerEventSinks } from './runner-event-sinks';
import { RunnerIngestService } from './runner-ingest.service';

const batch: RunnerEvent[] = [1, 2].map((seq) => ({
  v: 1,
  seq,
  ts: '2026-10-07T18:36:02.335Z',
  type: 'slot.checkpoint',
  source: 'code-sentinel',
  data: {},
}));

/** The slice of Prisma `events()` touches, over an in-memory events table. */
const fakePrisma = () => {
  const stored = new Set<bigint>();
  const state = { ackedSeq: 0n };
  const prisma = {
    event: {
      createMany: jest.fn(async ({ data }: { data: { seq: bigint }[] }) => {
        for (const row of data) stored.add(row.seq);
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where }: { where: { type?: string } }) =>
        where.type ? [] : [...stored].map((seq) => ({ seq })),
      ),
    },
    runner: {
      findUniqueOrThrow: jest.fn(async () => ({ ackedSeq: state.ackedSeq })),
    },
    $queryRaw: jest.fn(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const next = values[0] as bigint;
        if (next > state.ackedSeq) state.ackedSeq = next;
        return [{ ackedSeq: state.ackedSeq }];
      },
    ),
  };
  return { prisma, stored, state };
};

describe('RunnerIngestService.events', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const setup = () => {
    const { prisma, stored, state } = fakePrisma();
    const sinks = new RunnerEventSinks();
    const service = new RunnerIngestService(
      prisma as unknown as PrismaService,
      sinks,
    );
    return { service, sinks, stored, state };
  };

  it('dispatches before it stores', async () => {
    const { service, sinks, stored } = setup();
    const storedWhenDispatched: number[] = [];
    sinks.register({
      name: 'probe',
      handle: async () => {
        storedWhenDispatched.push(stored.size);
      },
    });
    await expect(service.events('rn_1', batch)).resolves.toBe(2n);
    expect(storedWhenDispatched).toEqual([0]);
    expect(stored.size).toBe(2);
  });

  it('stores nothing and keeps the ack when a sink throws; the resend stores', async () => {
    const { service, sinks, stored, state } = setup();
    let down = true;
    sinks.register({
      name: 'sessions',
      handle: async () => {
        if (down) throw new Error('database down');
      },
    });
    await expect(service.events('rn_1', batch)).rejects.toThrow(
      'database down',
    );
    expect(stored.size).toBe(0);
    expect(state.ackedSeq).toBe(0n);

    down = false;
    await expect(service.events('rn_1', batch)).resolves.toBe(2n);
    expect(stored.size).toBe(2);
  });

  it('dispatches a replayed batch again, though the events table skips it', async () => {
    const { service, sinks } = setup();
    const seen: number[][] = [];
    sinks.register({
      name: 'recorder',
      handle: async (_runnerId, events) => {
        seen.push(events.map((e) => e.seq));
      },
    });
    await service.events('rn_1', batch);
    await expect(service.events('rn_1', batch)).resolves.toBe(2n);
    expect(seen).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });
});
