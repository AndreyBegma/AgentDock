import type {
  BoardCardDetail,
  FilterStatRow,
  TokenEconomyReport,
  TokenEconomyTechniqueDef,
} from '@nautelle/shared';
import type { Prisma } from '@prisma/client';
import { BoardWorld } from '../board/testing/board-e2e';
import { usageByRun } from '../history/run-usage';
import { RunUsageFactsService } from './run-usage-facts.service';
import { TokenEconomyService } from './token-economy.service';

const FIXTURE: TokenEconomyTechniqueDef = {
  key: 'fixture',
  label: 'Fixture technique',
  defaultMode: 'ab',
  runKinds: ['card'],
};

describe('token economy (e2e)', () => {
  const w = new BoardWorld();
  let economy: TokenEconomyService;
  let facts: RunUsageFactsService;

  beforeAll(async () => {
    await w.init();
    economy = w.ctx.app.get(TokenEconomyService);
    facts = w.ctx.app.get(RunUsageFactsService);
  });
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    economy.techniques = [FIXTURE];
  });
  afterEach(async () => {
    economy.techniques = [];
    await w.work.settled();
  });

  const base = (projectId = w.a) => `/projects/${projectId}/token-economy`;
  const setShare = (bSharePercent: number, session = w.admin) =>
    session.send('put', `${base()}/settings`, { bSharePercent });
  const setMode = (mode: string, technique = 'fixture', session = w.admin) =>
    session.send('put', `${base()}/techniques/${technique}`, { mode });
  const arms = (cardId: string) =>
    w.ctx.prisma.cardTechniqueArm.findMany({ where: { cardId } });

  /** Creates card `n` and runs its first round; returns the card and run. */
  const ranCard = async () => {
    const { id, number } = await w.createCard();
    expect((await w.runCard(number)).status).toBe(200);
    const card = await w.card(number);
    return { id, number, card, runId: card.rounds[0].runId };
  };

  const advertise = async (caps: Record<string, boolean>) => {
    const runner = await w.ctx.prisma.runner.findUniqueOrThrow({
      where: { id: w.runnerId },
      select: { capabilities: true },
    });
    await w.ctx.prisma.runner.update({
      where: { id: w.runnerId },
      data: {
        capabilities: {
          ...(runner.capabilities as Prisma.InputJsonObject),
          ...caps,
        },
      },
    });
  };

  describe('assignment (D2, D10)', () => {
    it('writes one arm per technique at the first round, and later rounds read it unchanged', async () => {
      expect((await setShare(100)).status).toBe(200);
      const { id } = await ranCard();
      expect(await arms(id)).toEqual([
        expect.objectContaining({ technique: 'fixture', arm: 'b', mode: 'ab' }),
      ]);
      // The share and the mode change; the card keeps its arm.
      expect((await setShare(0)).status).toBe(200);
      expect((await setMode('off')).status).toBe(200);
      expect(await economy.cardFlags(w.a, id, false)).toEqual({
        fixture: true,
      });
      // A racing first launch inserts nothing twice.
      expect(await economy.cardFlags(w.a, id, true)).toEqual({ fixture: true });
      expect(await arms(id)).toHaveLength(1);
    });

    it('draws every ab card into a at a share of 0', async () => {
      await setShare(0);
      const { id } = await ranCard();
      expect((await arms(id))[0]).toMatchObject({ arm: 'a', mode: 'ab' });
    });

    it('after Enable for all, a new card is b with mode on', async () => {
      expect((await setMode('on')).status).toBe(200);
      await setShare(0);
      const { id } = await ranCard();
      expect((await arms(id))[0]).toMatchObject({ arm: 'b', mode: 'on' });
    });

    it('gives no arm for a technique registered after the first round', async () => {
      economy.techniques = [];
      const { id } = await ranCard();
      economy.techniques = [FIXTURE];
      await setMode('on');
      expect(await economy.cardFlags(w.a, id, false)).toEqual({
        fixture: true,
      });
      expect(await arms(id)).toEqual([]);
    });
  });

  describe('the launch (D11)', () => {
    it('sends no techniques to a runner without tokenEconomy, and is not refused', async () => {
      await w.advertiseTokenSaver();
      const { runId } = await ranCard();
      const [sent] = w.sent('card.run');
      expect(sent.tokenSaver).toEqual({ enabled: true, mcpAllow: [] });
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(run.techniques).toBeNull();
    });

    it('sends and snapshots the flags to a runner with tokenEconomy', async () => {
      // The production registry is what the strict command schema knows.
      economy.techniques = [];
      await w.advertiseTokenSaver();
      await advertise({ tokenEconomy: true });
      const { runId } = await ranCard();
      expect(w.sent('card.run')[0].tokenSaver).toEqual({
        enabled: true,
        mcpAllow: [],
        techniques: {},
      });
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(run.techniques).toEqual({});
    });
  });

  describe('retries (D4)', () => {
    const row = (
      id: string,
      runId: string,
      bypassed: boolean,
    ): FilterStatRow => ({
      id,
      runId,
      runKind: 'card',
      filter: 'js/jest',
      rawBytes: 4_000,
      // A bypassed command keeps every byte.
      keptBytes: bypassed ? 4_000 : 400,
      bypassed,
      passedThrough: false,
      at: '2026-10-14T12:00:00.000Z',
    });

    it('counts each newly inserted bypassed row once; a resent batch adds none', async () => {
      const { runId } = await ranCard();
      const batch = [
        row('r1', runId, true),
        row('r2', runId, true),
        row('r3', runId, false),
      ];
      await w.deliver('filter.stats', { rows: batch });
      await w.deliver('filter.stats', { rows: batch });
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(run.retries).toBe(2);
    });
  });

  describe('usage facts', () => {
    const minute = (n: number) => new Date(Date.UTC(2026, 9, 14, 10, n));
    let seq = 0;
    const request = (
      sessionId: string,
      at: number,
      over: Record<string, unknown> = {},
    ) => {
      seq += 1;
      return w.ctx.prisma.llmRequest.create({
        data: {
          sessionId,
          requestId: `q${seq}`,
          ts: minute(at),
          model: 'claude-opus-5-5',
          querySource: 'main',
          input: 100,
          output: 10,
          cacheRead: 700,
          cacheWrite5m: 150,
          cacheWrite1h: 50,
          costUsd: '0.010000',
          ...over,
        },
      });
    };

    it('match usageByRun plus the subagent sessions, with compactions, peak and turns', async () => {
      const { runId, card } = await ranCard();
      await w.ctx.prisma.run.update({
        where: { id: runId },
        data: { startedAt: minute(0), endedAt: minute(10) },
      });
      const session = await w.ctx.prisma.agentSession.create({
        data: {
          runnerId: w.runnerId,
          runtime: 'claude',
          externalId: card.sessionId as string,
          cwd: '/srv/dev/.wt-widget-card-x',
          origin: 'run',
          startedAt: minute(0),
          lastEventAt: minute(9),
        },
      });
      const child = await w.ctx.prisma.agentSession.create({
        data: {
          runnerId: w.runnerId,
          runtime: 'claude',
          externalId: 'agent-1',
          cwd: '/srv/dev/.wt-widget-card-x',
          origin: 'run',
          parentSessionId: session.id,
          startedAt: minute(3),
          lastEventAt: minute(4),
        },
      });
      await request(session.id, 2);
      await request(session.id, 5, { input: 2_000 });
      await request(session.id, 30); // after the run: not its own
      await request(child.id, 3, {
        costUsd: '0.005000',
        querySource: 'subagent',
      });
      await w.ctx.prisma.sessionCompaction.createMany({
        data: [
          {
            sessionId: session.id,
            compactionId: 'c1',
            ts: minute(4),
            trigger: 'auto',
          },
          {
            sessionId: session.id,
            compactionId: 'c2',
            ts: minute(20),
            trigger: 'auto',
          },
        ],
      });

      expect(await facts.buildRuns([runId])).toBe(1);
      const fact = await w.ctx.prisma.runUsageFact.findUniqueOrThrow({
        where: { runId },
      });
      const usage = (await usageByRun(w.ctx.prisma, [runId])).get(runId);
      expect(usage?.requests).toBe(2);
      expect(Number(fact.input)).toBe((usage?.input ?? 0) + 100);
      expect(Number(fact.cacheWrite5m)).toBe((usage?.cacheWrite5m ?? 0) + 150);
      expect(Number(fact.cacheWrite1h)).toBe((usage?.cacheWrite1h ?? 0) + 50);
      expect(fact.costUsd?.toFixed(6)).toBe('0.025000');
      expect(fact.subagentCostUsd?.toFixed(6)).toBe('0.005000');
      expect(fact).toMatchObject({
        projectId: w.a,
        compactions: 1,
        peakContext: 2_000 + 700 + 150 + 50,
        turns: 2,
        unpricedRequests: 0,
      });
    });

    it('the sweep builds ended card runs that have none, with zeros when there is no request', async () => {
      const { runId } = await ranCard();
      await w.ctx.prisma.run.update({
        where: { id: runId },
        data: { endedAt: new Date() },
      });
      expect(await facts.sweep()).toBeGreaterThanOrEqual(1);
      const fact = await w.ctx.prisma.runUsageFact.findUniqueOrThrow({
        where: { runId },
      });
      expect(fact).toMatchObject({ turns: 0, costUsd: null });
    });
  });

  describe('the re-priced estimate (D6)', () => {
    const minute = (n: number) => new Date(Date.UTC(2026, 9, 14, 10, n));

    const price = () =>
      w.ctx.prisma.priceVersion.create({
        data: {
          number: 1,
          source: 'admin',
          models: {
            create: {
              modelName: 'any',
              matchPattern: '.*',
              priority: 0,
              tiers: [
                {
                  name: 'Standard',
                  isDefault: true,
                  conditions: [],
                  prices: {
                    input: '0.000003',
                    output: '0.000015',
                    cacheWrite5m: '0.00000375',
                    cacheWrite1h: '0.000006',
                    cacheRead: '0.0000003',
                  },
                },
              ],
            },
          },
        },
      });

    /** A run with `main` main-loop requests, one a minute from minute 1. */
    const timeline = async (main: number, compactAt: number | null = null) => {
      await price();
      const { runId, card } = await ranCard();
      await w.ctx.prisma.run.update({
        where: { id: runId },
        data: { startedAt: minute(0), endedAt: minute(59) },
      });
      const session = await w.ctx.prisma.agentSession.create({
        data: {
          runnerId: w.runnerId,
          runtime: 'claude',
          externalId: card.sessionId as string,
          cwd: '/srv/dev/.wt-widget-card-x',
          origin: 'run',
          startedAt: minute(0),
          lastEventAt: minute(59),
        },
      });
      await w.ctx.prisma.llmRequest.createMany({
        data: Array.from({ length: main }, (_, i) => ({
          sessionId: session.id,
          requestId: `m${i}`,
          ts: minute(i + 1),
          model: 'claude-opus-5-5',
          querySource: 'main' as const,
          input: 10,
          cacheWrite5m: 10,
        })),
      });
      if (compactAt !== null) {
        await w.ctx.prisma.sessionCompaction.create({
          data: {
            sessionId: session.id,
            compactionId: 'c1',
            ts: minute(compactAt),
            trigger: 'auto',
          },
        });
      }
      return runId;
    };

    /** 10,000 tokens saved at `at`. */
    const saved = (runId: string, at: Date) =>
      w.deliver('filter.stats', {
        rows: [
          {
            id: `s-${at.getTime()}`,
            runId,
            runKind: 'card',
            filter: 'js/jest',
            rawBytes: 40_000,
            keptBytes: 0,
            bypassed: false,
            passedThrough: false,
            at: at.toISOString(),
          },
        ],
      });

    const detail = async (): Promise<BoardCardDetail> =>
      (await w.operator.get(`${w.path()}/board/cards/1`))
        .body as BoardCardDetail;

    it('is one cache write plus a read per remaining main-loop turn', async () => {
      const runId = await timeline(25);
      // Requests at minutes 1..25; after 5:30 there are 20.
      await saved(runId, new Date(Date.UTC(2026, 9, 14, 10, 5, 30)));
      const card = await detail();
      expect(card.tokenSaved?.estimateTokens).toBe(10_000);
      expect(card.tokenSaved?.estimateUsd).toBeCloseTo(0.0975, 8);
    });

    it('stops counting turns at the next compaction', async () => {
      const runId = await timeline(25, 10);
      // After 5:30 and before the compaction at 10:00: minutes 6..9.
      await saved(runId, new Date(Date.UTC(2026, 9, 14, 10, 5, 30)));
      expect((await detail()).tokenSaved?.estimateUsd).toBeCloseTo(
        10_000 * (0.00000375 + 0.0000003 * 4),
        8,
      );
    });

    it('a row outside the run’s requests takes half its main-loop requests', async () => {
      const runId = await timeline(25);
      await saved(runId, new Date(Date.UTC(2026, 9, 14, 10, 40)));
      expect((await detail()).tokenSaved?.estimateUsd).toBeCloseTo(
        10_000 * (0.00000375 + 0.0000003 * 12),
        8,
      );
    });
  });

  describe('the report', () => {
    const range = () => {
      const now = Date.now();
      return `from=${new Date(now - 86_400_000).toISOString()}&to=${new Date(now + 86_400_000).toISOString()}`;
    };

    it('gives, per technique and arm, the settled and merged cards and the signals', async () => {
      await setShare(0);
      const first = await ranCard();
      await setShare(100);
      const second = await ranCard();
      await w.ctx.prisma.boardCard.update({
        where: { id: first.id },
        data: { prState: 'merged' },
      });
      await w.ctx.prisma.boardCard.update({
        where: { id: second.id },
        data: { prState: 'closed' },
      });
      // The launch snapshots (D11): the strict command schema knows only the
      // production registry, so the fixture's flags are written here.
      await w.ctx.prisma.run.update({
        where: { id: first.runId },
        data: { techniques: { fixture: false } },
      });
      await w.ctx.prisma.run.update({
        where: { id: second.runId },
        data: { retries: 1, techniques: { fixture: true } },
      });
      // A card whose runs never launched the technique is left out.
      const unlaunched = await ranCard();
      await w.ctx.prisma.boardCard.update({
        where: { id: unlaunched.id },
        data: { prState: 'merged' },
      });
      const response = await w.viewer.get(`${base()}/report?${range()}`);
      expect(response.status).toBe(200);
      const body = response.body as TokenEconomyReport;
      expect(body.bSharePercent).toBe(100);
      expect(body.minCardsPerArm).toBe(30);
      const [t] = body.techniques;
      expect(t).toMatchObject({
        technique: 'fixture',
        mode: 'ab',
        enoughData: false,
        a: { settledCards: 1, mergedCards: 1 },
        b: { settledCards: 1, mergedCards: 0 },
      });
      expect(t.a.signals.noReviewReturns.point).toBe(1);
      expect(t.a.signals.rounds.point).toBe(1);
      expect(t.b.signals.noRetries.point).toBe(0);
      expect(t.b.costPerSuccessUsd.point).toBeNull();
      expect(t.a.costPerSuccessUsd.point).toBe(0);
    });

    it('refuses a member of another project, and never shows its cards', async () => {
      await ranCard();
      expect(
        (await w.operatorOfB.get(`${base()}/report?${range()}`)).status,
      ).toBe(404);
      expect((await w.outsider.get(`${base()}/report?${range()}`)).status).toBe(
        404,
      );
      const own = (await w.admin.get(`${base(w.b)}/report?${range()}`))
        .body as TokenEconomyReport;
      expect(
        own.techniques[0].a.settledCards + own.techniques[0].b.settledCards,
      ).toBe(0);
      expect(own.techniques[0].a.forcedCards).toBe(0);
    });

    it('refuses a reversed range', async () => {
      const response = await w.viewer.get(
        `${base()}/report?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z`,
      );
      expect(response.status).toBe(400);
    });
  });

  describe('authorization of the admin endpoints', () => {
    it('refuses an operator and a viewer, and allows the admin', async () => {
      for (const session of [w.operator, w.viewer]) {
        expect((await setShare(10, session)).status).toBe(403);
        expect((await setMode('on', 'fixture', session)).status).toBe(403);
      }
      expect((await setShare(10)).status).toBe(200);
      expect((await setMode('on')).status).toBe(200);
      const [audit] = await w.audit('project.update');
      expect(audit).toBeDefined();
    });

    it('refuses a member of another project as not found', async () => {
      expect((await setShare(10, w.operatorOfB)).status).toBe(404);
      expect((await setMode('on', 'fixture', w.operatorOfB)).status).toBe(404);
    });

    it('validates the share and the mode, and 404s an unknown technique', async () => {
      expect((await setShare(101)).status).toBe(400);
      expect((await setShare(1.5)).status).toBe(400);
      expect((await setMode('maybe')).status).toBe(400);
      expect((await setMode('on', 'nope')).status).toBe(404);
    });
  });
});
