import type {
  UsageBreakdownResponse,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
} from '@agentdock/shared';
import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import { seedPrices } from '../prices/seed-prices';
import {
  adminSession,
  createRunnerE2eApp,
  type RunnerE2eContext,
} from '../runners/testing/runner-e2e';
import {
  createUser,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import {
  at,
  Events,
  fromScratch,
  HOUR,
  ingest,
  projectRow,
  resetUsage,
  rollupRows,
  runnerRow,
  T0,
} from './testing/usage-e2e';

const SONNET = 'claude-sonnet-4-5-20250929';

/** A small deterministic PRNG, so a failing randomized run can be replayed. */
const prng = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

describe('usage (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;

  beforeAll(async () => {
    ctx = await createRunnerE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetUsage(ctx.prisma);
    await seedPrices(ctx.prisma);
    admin = await adminSession(ctx);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const range = `from=${at(-HOUR)}&to=${at(48 * HOUR)}`;

  const member = async (projectId: string, email: string, role = 'viewer') => {
    const user = await createUser(
      ctx.prisma,
      email,
      role as 'viewer' | 'operator',
    );
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    return login(ctx, email);
  };

  describe('cost at ingest (D6)', () => {
    it('prices a known model, leaves an unknown one unpriced, and the summary says so', async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma);
      const project = await projectRow(ctx.prisma, runnerId, 'widget');
      const e = new Events();
      await ingest(ctx, runnerId, [
        e.observed('s1', at(0), { projectId: project.id, slot: 'i42' }),
        e.request(
          's1',
          'r1',
          SONNET,
          {
            input: 1200,
            output: 850,
            cacheRead: 40_000,
            cacheWrite5m: 2000,
            cacheWrite1h: 1000,
          },
          at(10),
        ),
        e.request('s1', 'r2', 'my-local-llama', { input: 500 }, at(20)),
      ]);

      const rows = await ctx.prisma.llmRequest.findMany({
        orderBy: { requestId: 'asc' },
        select: { costUsd: true, priceVersion: true, costSource: true },
      });
      expect(rows[0].costUsd?.toFixed(6)).toBe('0.041850');
      expect(rows[0].priceVersion).toBe(1);
      expect(rows[0].costSource).toBe('computed');
      expect(rows[1].costUsd).toBeNull();
      expect(rows[1].costSource).toBeNull();

      const summary = await admin.get(`/usage/summary?${range}`);
      expect(summary.status).toBe(200);
      const body = summary.body as UsageSummaryResponse;
      expect(body.totals).toMatchObject({
        requests: 2,
        unpricedRequests: 1,
        costUsd: '0.041850',
        input: 1700,
      });
      expect(body.byRuntime).toEqual([
        expect.objectContaining({ runtime: 'claude', unpricedRequests: 1 }),
      ]);
    });

    it('replaces a re-sent request in its rollup instead of adding it twice (spec 12 D4)', async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma);
      const e = new Events();
      await ingest(ctx, runnerId, [
        e.request('s1', 'r1', SONNET, { input: 100 }, at(10)),
      ]);
      await ingest(ctx, runnerId, [
        e.request('s1', 'r1', SONNET, { input: 300 }, at(10)),
      ]);
      expect(await rollupRows(ctx.prisma)).toEqual(
        await fromScratch(ctx.prisma),
      );
      const [row] = await rollupRows(ctx.prisma);
      expect(row).toMatchObject({ requests: 1, input: '300' });
    });

    it('moves usage to the project a session is attributed to later', async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma);
      const project = await projectRow(ctx.prisma, runnerId, 'widget');
      const e = new Events();
      // The request arrives before its session.observed: a project-less placeholder.
      await ingest(ctx, runnerId, [
        e.request('s1', 'r1', SONNET, { input: 100 }, at(10)),
      ]);
      expect((await rollupRows(ctx.prisma))[0].projectId).toBeNull();
      await ingest(ctx, runnerId, [
        e.observed('s1', at(0), { projectId: project.id, slot: 'i7' }),
      ]);
      const rows = await rollupRows(ctx.prisma);
      expect(rows).toEqual(await fromScratch(ctx.prisma));
      expect(rows).toEqual([
        expect.objectContaining({ projectId: project.id, slot: 'i7' }),
      ]);
    });

    it('attributes the issue from the slot run covering the request', async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma);
      const project = await projectRow(ctx.prisma, runnerId, 'widget');
      for (const [issue, start] of [
        [41, -HOUR],
        [42, 30],
      ] as const) {
        await ctx.prisma.slot.create({
          data: {
            projectId: project.id,
            name: 'api',
            issue,
            worktree: '/srv/dev/.wt-api',
            owns: [],
            never: [],
            status: 'running',
            lastSeq: 0n,
            startedAt: new Date(T0 + start * 1000),
            updatedAt: new Date(T0),
          },
        });
      }
      const e = new Events();
      await ingest(ctx, runnerId, [
        e.observed('s1', at(0), { projectId: project.id, slot: 'api' }),
        e.request('s1', 'r1', SONNET, { input: 1 }, at(10)),
        e.request('s1', 'r2', SONNET, { input: 2 }, at(60)),
      ]);
      const rows = await rollupRows(ctx.prisma);
      expect(rows.map((r) => [r.issue, r.input])).toEqual([
        [41, '1'],
        [42, '2'],
      ]);
      const breakdown = await admin.get(
        `/usage/breakdown?${range}&dimension=issue`,
      );
      expect(
        (breakdown.body as UsageBreakdownResponse).rows.map((r) => [
          r.key,
          r.projectId,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['41', project.id],
          ['42', project.id],
        ]),
      );
    });
  });

  describe('rollups equal SUM over llm_requests (D8)', () => {
    it('for 500 randomized requests, with re-sends and late attribution', async () => {
      const random = prng(13);
      const pick = <T>(list: readonly T[]): T =>
        list[Math.floor(random() * list.length)];
      const { id: runnerId } = await runnerRow(ctx.prisma);
      const projects = [
        await projectRow(ctx.prisma, runnerId, 'a'),
        await projectRow(ctx.prisma, runnerId, 'b'),
      ];
      const models = [SONNET, 'gpt-5.3-codex', 'claude-haiku-5-5', 'unknown-x'];
      const sessions = ['s1', 's2', 's3', 's4', 's5', 's6'];
      const e = new Events();
      const events: RunnerEvent[] = [];
      for (let i = 0; i < 500; i += 1) {
        const requestId = `r${Math.floor(random() * 420)}`;
        const output = Math.floor(random() * 5000);
        events.push(
          e.request(
            pick(sessions),
            requestId,
            pick(models),
            {
              input: Math.floor(random() * 150_000),
              output,
              reasoning: Math.floor(random() * output),
              cacheRead: Math.floor(random() * 50_000),
              cacheWrite5m: Math.floor(random() * 3000),
              cacheWrite1h: Math.floor(random() * 3000),
            },
            at(Math.floor(random() * 30 * HOUR)),
          ),
        );
        // Sessions get their project midway through, some never.
        if (i % 97 === 50) {
          events.push(
            e.observed(pick(sessions), at(0), {
              projectId: pick(projects).id,
              slot: pick(['i1', 'i2']),
            }),
          );
        }
      }
      for (let i = 0; i < events.length; i += 120) {
        await ingest(ctx, runnerId, events.slice(i, i + 120));
      }
      const rollups = await rollupRows(ctx.prisma);
      expect(rollups.length).toBeGreaterThan(20);
      expect(rollups).toEqual(await fromScratch(ctx.prisma));
    });

    it('under concurrent ingests into the same hours', async () => {
      const runners = [
        await runnerRow(ctx.prisma, 'one'),
        await runnerRow(ctx.prisma, 'two'),
        await runnerRow(ctx.prisma, 'three'),
      ];
      await Promise.all(
        runners.map(async ({ id }, n) => {
          const e = new Events();
          for (let b = 0; b < 4; b += 1) {
            const batch = Array.from({ length: 25 }, (_, i) =>
              e.request(
                `s${n}`,
                `r${b}-${i}`,
                SONNET,
                { input: 100 + i, output: 10 },
                at((i % 3) * HOUR + b),
              ),
            );
            await ingest(ctx, id, batch);
          }
        }),
      );
      const rollups = await rollupRows(ctx.prisma);
      expect(rollups).toEqual(await fromScratch(ctx.prisma));
      expect(rollups.reduce((n, r) => n + r.requests, 0)).toBe(300);
    });
  });

  describe('authorization (D9)', () => {
    let projectA: string;
    let projectB: string;
    let viewerA: Session;

    beforeEach(async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma);
      projectA = (await projectRow(ctx.prisma, runnerId, 'a')).id;
      projectB = (await projectRow(ctx.prisma, runnerId, 'b')).id;
      const e = new Events();
      await ingest(ctx, runnerId, [
        e.observed('sa', at(0), { projectId: projectA }),
        e.observed('sb', at(0), { projectId: projectB }),
        e.request('sa', 'r1', SONNET, { input: 1_000_000 }, at(10)),
        e.request('sb', 'r2', SONNET, { input: 2_000_000 }, at(10)),
        e.request('s-machine', 'r3', SONNET, { input: 4_000_000 }, at(10)),
      ]);
      viewerA = await member(projectA, 'viewer@example.com');
    });

    const routes = [
      `/usage/summary?${range}`,
      `/usage/timeseries?${range}`,
      `/usage/breakdown?${range}&dimension=project`,
    ];

    it('is 404 for a project the caller is not a member of, on every route', async () => {
      for (const route of routes) {
        const response = await viewerA.get(`${route}&projectId=${projectB}`);
        expect([route, response.status]).toEqual([route, 404]);
        const missing = await admin.get(`${route}&projectId=nope`);
        expect([route, missing.status]).toEqual([route, 404]);
      }
    });

    it('keeps other projects and machine-wide usage out of a member’s unfiltered view', async () => {
      // input at 3e-6: A 3.00, B 6.00, machine-wide 12.00.
      const summary = (await viewerA.get(`/usage/summary?${range}`))
        .body as UsageSummaryResponse;
      expect(summary.totals).toMatchObject({
        costUsd: '3.000000',
        requests: 1,
      });

      const breakdown = (
        await viewerA.get(`/usage/breakdown?${range}&dimension=project`)
      ).body as UsageBreakdownResponse;
      expect(breakdown.rows.map((r) => r.key)).toEqual([projectA]);

      const series = (
        await viewerA.get(`/usage/timeseries?${range}&groupBy=project`)
      ).body as UsageTimeseriesResponse;
      expect(series.series.map((s) => s.key)).toEqual([projectA]);
    });

    it('shows admins every project and the machine-wide usage', async () => {
      const summary = (await admin.get(`/usage/summary?${range}`))
        .body as UsageSummaryResponse;
      expect(summary.totals.costUsd).toBe('21.000000');
      const breakdown = (
        await admin.get(`/usage/breakdown?${range}&dimension=project`)
      ).body as UsageBreakdownResponse;
      expect(breakdown.rows.map((r) => [r.key, r.costUsd])).toEqual([
        [null, '12.000000'],
        [projectB, '6.000000'],
        [projectA, '3.000000'],
      ]);
      expect(breakdown.rows[2].label).toBe('a');
    });

    it('refuses a bad range and an unknown time zone', async () => {
      expect(
        (await admin.get(`/usage/summary?from=${at(10)}&to=${at(0)}`)).status,
      ).toBe(400);
      expect(
        (await admin.get(`/usage/timeseries?${range}&tz=Mars/Olympus`)).status,
      ).toBe(400);
      expect(
        (await admin.get(`/usage/breakdown?${range}&dimension=color`)).status,
      ).toBe(400);
    });
  });

  describe('timeseries', () => {
    it('fills every bucket and cuts days in the requested zone', async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma);
      const e = new Events();
      // 18:00Z and 23:30Z on 2026-10-07: one day in UTC, two in Asia/Kolkata
      // (+5:30) — 23:30 on the 7th and 05:00 on the 8th.
      await ingest(ctx, runnerId, [
        e.request('s1', 'r1', SONNET, { input: 10, output: 5 }, at(0)),
        e.request(
          's1',
          'r2',
          SONNET,
          { input: 20, output: 5, reasoning: 2 },
          at(5.5 * HOUR),
        ),
      ]);
      const window = `from=${at(0)}&to=${at(6 * HOUR)}`;
      const hourly = (await admin.get(`/usage/timeseries?${window}`))
        .body as UsageTimeseriesResponse;
      expect(hourly.series).toHaveLength(1);
      expect(hourly.series[0].points).toHaveLength(6);
      expect(hourly.series[0].points[0]).toMatchObject({
        t: '2026-10-07T18:00:00.000Z',
        tokens: 15,
        requests: 1,
      });
      expect(hourly.series[0].points[1]).toMatchObject({ requests: 0 });

      const utc = (await admin.get(`/usage/timeseries?${window}&interval=day`))
        .body as UsageTimeseriesResponse;
      expect(utc.series[0].points.map((p) => [p.t, p.requests])).toEqual([
        ['2026-10-07T00:00:00.000Z', 2],
      ]);
      const kolkata = (
        await admin.get(
          `/usage/timeseries?${window}&interval=day&tz=Asia/Kolkata`,
        )
      ).body as UsageTimeseriesResponse;
      expect(kolkata.series[0].points.map((p) => [p.t, p.requests])).toEqual([
        ['2026-10-06T18:30:00.000Z', 1],
        ['2026-10-07T18:30:00.000Z', 1],
      ]);
    });
  });
});
