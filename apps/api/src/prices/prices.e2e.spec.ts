import type {
  CurrentPricesResponse,
  ModelPriceInput,
  PriceTestResponse,
  PriceVersionListResponse,
  PriceVersionSummary,
  RecomputeProgress,
  UsageSummaryResponse,
} from '@agentdock/shared';
import { Logger } from '@nestjs/common';
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
} from '../usage/testing/usage-e2e';
import { RecomputeService } from './recompute.service';
import { seedPrices } from './seed-prices';

const SONNET = 'claude-sonnet-4-5-20250929';

/** Sonnet at double the seeded input price. */
const pricier: ModelPriceInput = {
  modelName: SONNET,
  matchPattern: '^claude-sonnet-4-5(-20250929)?$',
  priority: 0,
  tiers: [
    {
      name: 'Standard',
      isDefault: true,
      conditions: [],
      prices: { input: '0.000006', output: '0.000015' },
    },
  ],
};

describe('prices (e2e)', () => {
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
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const newVersion = (body: object) =>
    admin.send('post', '/admin/prices/versions', {
      note: 'test',
      upsert: [],
      remove: [],
      ...body,
    });

  const recomputed = async (body: object): Promise<RecomputeProgress> => {
    const started = await admin.send('post', '/admin/prices/recompute', body);
    expect(started.status).toBe(202);
    await ctx.app.get(RecomputeService).idle();
    const progress = await admin.get(
      `/admin/prices/recompute/${(started.body as RecomputeProgress).id}`,
    );
    return progress.body as RecomputeProgress;
  };

  it('seeds version 1 from the snapshot once', async () => {
    expect(await seedPrices(ctx.prisma)).toEqual({
      created: false,
      conversion: null,
    });
    const current = (await admin.get('/admin/prices'))
      .body as CurrentPricesResponse;
    expect(current.version).toMatchObject({
      number: 1,
      source: 'langfuse-seed',
      models: 161,
    });
    expect(current.models.map((m) => m.modelName)).toContain(SONNET);
  });

  describe('admin only (D9)', () => {
    it('is 403 for operators and viewers on every /admin/prices route', async () => {
      for (const role of ['operator', 'viewer'] as const) {
        await createUser(ctx.prisma, `${role}@example.com`, role);
        const caller = await login(ctx, `${role}@example.com`);
        const responses = [
          await caller.get('/admin/prices'),
          await caller.get('/admin/prices/versions'),
          await caller.send('post', '/admin/prices/versions', {
            note: 'x',
            upsert: [],
            remove: [],
          }),
          await caller.send('post', '/admin/prices/test', {
            model: SONNET,
            tokens: {},
          }),
          await caller.send('post', '/admin/prices/recompute', {
            from: at(0),
            to: at(1),
            versionId: 'x',
          }),
          await caller.get('/admin/prices/recompute/x'),
        ];
        expect(responses.map((r) => r.status)).toEqual([
          403, 403, 403, 403, 403, 403,
        ]);
      }
    });
  });

  describe('versions (D2)', () => {
    it('clones the current version with the edits, and keeps earlier costs', async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma);
      const e = new Events();
      await ingest(ctx, runnerId, [
        e.request('s1', 'r1', SONNET, { input: 1_000_000 }, at(10)),
      ]);

      const created = await newVersion({
        upsert: [pricier],
        remove: ['gpt-4o'],
      });
      expect(created.status).toBe(201);
      expect(created.body as PriceVersionSummary).toMatchObject({
        number: 2,
        source: 'admin',
        models: 160,
        createdBy: { email: 'admin@example.com' },
      });

      const first = await ctx.prisma.llmRequest.findFirstOrThrow({
        select: { costUsd: true, priceVersion: true },
      });
      expect(first.costUsd?.toFixed(6)).toBe('3.000000');
      expect(first.priceVersion).toBe(1);

      // New requests use the new version.
      await ingest(ctx, runnerId, [
        e.request('s1', 'r2', SONNET, { input: 1_000_000 }, at(20)),
      ]);
      const second = await ctx.prisma.llmRequest.findFirstOrThrow({
        where: { requestId: 'r2' },
        select: { costUsd: true, priceVersion: true },
      });
      expect(second.costUsd?.toFixed(6)).toBe('6.000000');
      expect(second.priceVersion).toBe(2);

      const list = (await admin.get('/admin/prices/versions'))
        .body as PriceVersionListResponse;
      expect(list.versions.map((v) => [v.number, v.source])).toEqual([
        [2, 'admin'],
        [1, 'langfuse-seed'],
      ]);
      const audit = await ctx.prisma.auditRecord.findFirst({
        where: {
          action: 'prices.version_create',
          targetId: (created.body as PriceVersionSummary).id,
        },
      });
      expect(audit?.result).toBe('ok');
    });

    it('refuses an invalid regex, a missing default tier, an unknown remove and a bad price', async () => {
      const bad = [
        { upsert: [{ ...pricier, matchPattern: '(' }] },
        {
          upsert: [
            { ...pricier, tiers: [{ ...pricier.tiers[0], isDefault: false }] },
          ],
        },
        { remove: ['no-such-model'] },
        {
          upsert: [
            {
              ...pricier,
              tiers: [
                {
                  ...pricier.tiers[0],
                  prices: { input: '-1', output: '0' },
                },
              ],
            },
          ],
        },
      ];
      for (const body of bad) {
        const response = await newVersion(body);
        expect([JSON.stringify(body), response.status]).toEqual([
          JSON.stringify(body),
          400,
        ]);
      }
      expect(await ctx.prisma.priceVersion.count()).toBe(1);
    });

    it('tests a model id against the current version', async () => {
      const response = await admin.send('post', '/admin/prices/test', {
        model: 'claude-haiku-5-5',
        tokens: { input: 200_000, output: 1000 },
      });
      expect(response.status).toBe(200);
      expect(response.body as PriceTestResponse).toEqual({
        version: 1,
        modelName: 'claude-haiku-5-5',
        tier: 'Large Context (>100K)',
        // 200000·5e-7 + 1000·2.5e-6
        costUsd: '0.102500',
      });
      const unknown = await admin.send('post', '/admin/prices/test', {
        model: 'nothing-matches',
        tokens: { input: 1 },
      });
      expect(unknown.body).toMatchObject({ modelName: null, costUsd: null });
    });
  });

  describe('recompute (D7)', () => {
    it('re-prices exactly the requests in the range and rebuilds their hours', async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma);
      const e = new Events();
      await ingest(ctx, runnerId, [
        e.request('s1', 'before', SONNET, { input: 1_000_000 }, at(-1)),
        e.request('s1', 'in-1', SONNET, { input: 1_000_000 }, at(0)),
        e.request('s1', 'in-2', SONNET, { input: 1_000_000 }, at(HOUR + 5)),
        e.request('s1', 'at-end', SONNET, { input: 1_000_000 }, at(2 * HOUR)),
      ]);
      const v2 = (await newVersion({ upsert: [pricier] }))
        .body as PriceVersionSummary;

      const done = await recomputed({
        from: at(0),
        to: at(2 * HOUR),
        versionId: v2.id,
      });
      expect(done).toMatchObject({
        status: 'done',
        processed: 2,
        total: 2,
        versionNumber: 2,
      });

      const rows = await ctx.prisma.llmRequest.findMany({
        orderBy: { ts: 'asc' },
        select: { requestId: true, costUsd: true, priceVersion: true },
      });
      expect(
        rows.map((r) => [r.requestId, r.costUsd?.toFixed(2), r.priceVersion]),
      ).toEqual([
        ['before', '3.00', 1],
        ['in-1', '6.00', 2],
        ['in-2', '6.00', 2],
        ['at-end', '3.00', 1],
      ]);
      expect(await rollupRows(ctx.prisma)).toEqual(
        await fromScratch(ctx.prisma),
      );
      const summary = (
        await admin.get(`/usage/summary?from=${at(-HOUR)}&to=${at(3 * HOUR)}`)
      ).body as UsageSummaryResponse;
      expect(summary.totals.costUsd).toBe('18.000000');
    });

    it('re-prices in batches, prices nothing a version lacks, and audits', async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma);
      const e = new Events();
      await ingest(
        ctx,
        runnerId,
        Array.from({ length: 25 }, (_, i) =>
          e.request('s1', `r${i}`, SONNET, { input: 1000 }, at(i * 60)),
        ),
      );
      const v2 = (await newVersion({ remove: [SONNET] }))
        .body as PriceVersionSummary;
      const done = await recomputed({
        from: at(0),
        to: at(HOUR),
        versionId: v2.id,
      });
      expect(done).toMatchObject({ status: 'done', processed: 25 });
      expect(
        await ctx.prisma.llmRequest.count({ where: { costUsd: null } }),
      ).toBe(25);
      const [rollup] = await rollupRows(ctx.prisma);
      expect(rollup).toMatchObject({ unpriced: 25, cost: '0.000000' });
      expect(
        await ctx.prisma.auditRecord.count({
          where: { action: 'prices.recompute', targetId: done.id },
        }),
      ).toBe(1);
    });

    it('is 409 while one is running, 400 for an empty range, 404 for an unknown version', async () => {
      const v1 = await ctx.prisma.priceVersion.findFirstOrThrow({
        select: { id: true },
      });
      await ctx.prisma.priceRecompute.create({
        data: {
          versionId: v1.id,
          from: new Date(at(0)),
          to: new Date(at(1)),
          status: 'running',
        },
      });
      const body = { from: at(0), to: at(HOUR), versionId: v1.id };
      expect(
        (await admin.send('post', '/admin/prices/recompute', body)).status,
      ).toBe(409);
      expect(
        (
          await admin.send('post', '/admin/prices/recompute', {
            ...body,
            to: at(0),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await admin.send('post', '/admin/prices/recompute', {
            ...body,
            versionId: 'nope',
          })
        ).status,
      ).toBe(404);
    });
  });

  describe('OTel and transcript copies of one request (D14, D15)', () => {
    /** What OTel reports for a request: cache writes not split by TTL, its own cost. */
    const otel = (e: Events, extra: object = {}, envelope: object = {}) =>
      e.request(
        's1',
        'req_1',
        SONNET,
        { input: 1000, output: 100, cacheWrite5m: 3000 },
        at(10),
        {
          source: 'otel',
          cacheWriteTtlUnknown: true,
          reportedCostUsd: 0.0321,
          durationMs: 2345,
          ...extra,
        },
        envelope,
      );
    /** The transcript's copy: the 3000 written tokens split 2000 / 1000. */
    const transcript = (e: Events) =>
      e.request(
        's1',
        'req_1',
        SONNET,
        { input: 1000, output: 100, cacheWrite5m: 2000, cacheWrite1h: 1000 },
        at(10),
        { durationMs: 2400, durationApprox: true },
      );

    // 1000·3e-6 + 100·15e-6 + 2000·3.75e-6 + 1000·6e-6 = 0.003 + 0.0015 + 0.0075 + 0.006
    const SPLIT_COST = '0.018000';
    // 1000·3e-6 + 100·15e-6 + 3000·3.75e-6
    const OTEL_COST = '0.015750';

    const stored = () =>
      ctx.prisma.llmRequest.findMany({
        select: {
          cacheWrite5m: true,
          cacheWrite1h: true,
          cacheWriteTtlUnknown: true,
          source: true,
          reportedCostUsd: true,
          costUsd: true,
          durationMs: true,
          durationApprox: true,
        },
      });

    const merged = {
      cacheWrite5m: 2000,
      cacheWrite1h: 1000,
      cacheWriteTtlUnknown: false,
      source: 'transcript',
      durationMs: 2345,
      durationApprox: false,
    };

    it('OTel first, then the transcript: one row with the split, re-priced', async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma);
      const e = new Events();
      await ingest(ctx, runnerId, [otel(e)]);
      const [live] = await stored();
      expect(live).toMatchObject({
        cacheWrite5m: 3000,
        cacheWriteTtlUnknown: true,
        source: 'otel',
      });
      expect(live.costUsd?.toFixed(6)).toBe(OTEL_COST);

      await ingest(ctx, runnerId, [transcript(e)]);
      const rows = await stored();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject(merged);
      expect(rows[0].costUsd?.toFixed(6)).toBe(SPLIT_COST);
      expect(rows[0].reportedCostUsd?.toFixed(4)).toBe('0.0321');
      expect(await rollupRows(ctx.prisma)).toEqual(
        await fromScratch(ctx.prisma),
      );
    });

    it('transcript first, then OTel: the split stays, OTel adds its cost and duration', async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma);
      const e = new Events();
      await ingest(ctx, runnerId, [transcript(e)]);
      await ingest(ctx, runnerId, [otel(e)]);
      const rows = await stored();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject(merged);
      expect(rows[0].costUsd?.toFixed(6)).toBe(SPLIT_COST);
      expect(rows[0].reportedCostUsd?.toFixed(4)).toBe('0.0321');
      const [rollup] = await rollupRows(ctx.prisma);
      expect(rollup).toMatchObject({
        requests: 1,
        cacheWrite5m: '2000',
        cost: SPLIT_COST,
      });
    });

    it('attributes a live session from the OTel envelope, only to the sender’s own project', async () => {
      const { id: runnerId } = await runnerRow(ctx.prisma, 'mine');
      const { id: otherRunner } = await runnerRow(ctx.prisma, 'other');
      const project = await projectRow(ctx.prisma, runnerId, 'widget');
      const foreign = await projectRow(ctx.prisma, otherRunner, 'secret');

      const e = new Events();
      await ingest(ctx, runnerId, [
        otel(
          e,
          {},
          {
            source: 'otel',
            project: { repo: foreign.repo, root: foreign.rootPath },
            slot: 'x',
          },
        ),
      ]);
      expect(
        await ctx.prisma.agentSession.findFirst({
          select: { projectId: true },
        }),
      ).toEqual({ projectId: null });

      await ingest(ctx, runnerId, [
        otel(
          e,
          {},
          {
            source: 'otel',
            project: { repo: project.repo, root: project.rootPath },
            slot: 'i42',
            issue: 42,
          },
        ),
      ]);
      expect(
        await ctx.prisma.agentSession.findFirst({
          select: { projectId: true, slotName: true },
        }),
      ).toEqual({ projectId: project.id, slotName: 'i42' });
      expect(await rollupRows(ctx.prisma)).toEqual([
        expect.objectContaining({ projectId: project.id, slot: 'i42' }),
      ]);

      // The transcript's session.observed still decides.
      await ingest(ctx, runnerId, [
        e.observed('s1', at(0), { projectId: project.id, slot: 'i43' }),
        transcript(e),
      ]);
      const rows = await rollupRows(ctx.prisma);
      expect(rows).toEqual([
        expect.objectContaining({ projectId: project.id, slot: 'i43' }),
      ]);
      expect(rows).toEqual(await fromScratch(ctx.prisma));
    });
  });
});
