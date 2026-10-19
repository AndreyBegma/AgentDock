import type {
  BoardCardDetail,
  FilterStatRow,
  TokenSaverSettingsView,
  TokenSaverSummary,
} from '@agentdock/shared';
import { BoardWorld, ROOT_B } from '../board/testing/board-e2e';
import type { LocalCall } from '../local/local-call';
import { LocalHandlers } from '../local/local-handlers';

/** USD per input token of the test price: $3 / MTok. */
const INPUT_PRICE = '0.000003';

describe('token saver (e2e)', () => {
  const w = new BoardWorld();
  let handlers: LocalHandlers;

  beforeAll(async () => {
    await w.init();
    handlers = w.ctx.app.get(LocalHandlers);
  });
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const settings = (projectId = w.a) => `/projects/${projectId}/token-saver`;
  const summary = (projectId = w.a, query = RANGE) =>
    `/projects/${projectId}/token-saver/summary?${query}`;
  const RANGE = 'from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z';

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
                prices: { input: INPUT_PRICE, output: '0.000015' },
              },
            ],
          },
        },
      },
    });

  let rowSeq = 0;
  const row = (over: Partial<FilterStatRow> = {}): FilterStatRow => {
    rowSeq += 1;
    return {
      id: `row_${rowSeq}`,
      runId: null,
      runKind: 'orchestrator',
      filter: 'js/jest',
      rawBytes: 4_000,
      keptBytes: 400,
      bypassed: false,
      passedThrough: false,
      at: '2026-10-14T12:00:00.000Z',
      ...over,
    };
  };

  const stats = (rows: FilterStatRow[], root?: string) =>
    w.deliver(
      'filter.stats',
      { rows },
      root ? { project: { repo: 'acme/widget', root } } : {},
    );

  const detail = async (number = 1): Promise<BoardCardDetail> => {
    const response = await w.operator.get(`${w.path()}/board/cards/${number}`);
    expect(response.status).toBe(200);
    return response.body as BoardCardDetail;
  };

  /** Card 1, run once; its round's run id. */
  const ranCard = async (): Promise<string> => {
    await w.createCard();
    expect((await w.runCard(1)).status).toBe(200);
    return (await w.card(1)).rounds[0].runId;
  };

  describe('the setting', () => {
    it('reads the default for a project without a row', async () => {
      const response = await w.viewer.get(settings());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        enabled: true,
        mcpAllow: [],
        updatedAt: null,
      });
    });

    it('a project admin changes it, audited; an operator cannot', async () => {
      const denied = await w.operator.send('put', settings(), {
        enabled: false,
        mcpAllow: [],
      });
      expect(denied.status).toBe(403);
      const saved = await w.admin.send('put', settings(), {
        enabled: false,
        mcpAllow: ['playwright'],
      });
      expect(saved.status).toBe(200);
      const view = saved.body as TokenSaverSettingsView;
      expect(view).toMatchObject({ enabled: false, mcpAllow: ['playwright'] });
      expect(view.updatedAt).not.toBeNull();
      expect((await w.viewer.get(settings())).body).toMatchObject({
        enabled: false,
        mcpAllow: ['playwright'],
      });
      const [record] = await w.audit('project.update');
      expect(record).toMatchObject({ projectId: w.a, result: 'ok' });
    });

    it('refuses an invalid allowlist', async () => {
      for (const mcpAllow of [['bad name'], ['a', 'a'], 'playwright']) {
        const response = await w.admin.send('put', settings(), {
          enabled: true,
          mcpAllow,
        });
        expect(response.status).toBe(400);
      }
      const extra = await w.admin.send('put', settings(), {
        enabled: true,
        mcpAllow: [],
        other: 1,
      });
      expect(extra.status).toBe(400);
    });
  });

  describe('authorization', () => {
    it("a member of B never reads or changes A's setting or summary", async () => {
      expect((await w.operatorOfB.get(settings(w.a))).status).toBe(404);
      expect((await w.operatorOfB.get(summary(w.a))).status).toBe(404);
      expect(
        (
          await w.operatorOfB.send('put', settings(w.a), {
            enabled: false,
            mcpAllow: [],
          })
        ).status,
      ).toBe(404);
      expect((await w.outsider.get(settings(w.a))).status).toBe(404);
      expect((await w.outsider.get(summary(w.a))).status).toBe(404);
      // Their own project answers.
      expect((await w.operatorOfB.get(settings(w.b))).status).toBe(200);
      expect((await w.operatorOfB.get(summary(w.b))).status).toBe(200);
    });
  });

  describe('launch commands (capability gate)', () => {
    it('a runner without the capability gets no field; the run is off', async () => {
      const runId = await ranCard();
      const [sent] = w.sent('card.run');
      expect(sent).not.toHaveProperty('tokenSaver');
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(run.tokenSaver).toBe(false);
    });

    it('a runner that advertises it gets the setting; the run is on', async () => {
      await w.advertiseTokenSaver();
      await w.admin.send('put', settings(), {
        enabled: true,
        mcpAllow: ['playwright'],
      });
      const runId = await ranCard();
      expect(w.sent('card.run')[0].tokenSaver).toEqual({
        enabled: true,
        mcpAllow: ['playwright'],
      });
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(run.tokenSaver).toBe(true);
    });

    it('switched off, the runner is told so and the run is off', async () => {
      await w.advertiseTokenSaver();
      await w.admin.send('put', settings(), { enabled: false, mcpAllow: [] });
      const runId = await ranCard();
      expect(w.sent('card.run')[0].tokenSaver).toEqual({
        enabled: false,
        mcpAllow: [],
      });
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(run.tokenSaver).toBe(false);
    });
  });

  describe('filter.stats ingest', () => {
    it('stores rows once, with the project of the envelope', async () => {
      const runId = await ranCard();
      const rows = [
        row({ runId, runKind: 'card' }),
        row({ runId: null, runKind: 'orchestrator' }),
      ];
      await stats(rows);
      await stats(rows);
      const stored = await w.ctx.prisma.tokenSaverStat.findMany({
        orderBy: { id: 'asc' },
      });
      expect(stored).toHaveLength(2);
      expect(stored.every((s) => s.projectId === w.a)).toBe(true);
      expect(stored.map((s) => s.runId)).toEqual([runId, null]);
    });

    it('drops a run of another project, and skips what it cannot place', async () => {
      const runId = await ranCard();
      // A's run named in B's envelope: B's row, without the run.
      await stats([row({ runId, runKind: 'card' })], ROOT_B);
      // An unknown root and malformed data store nothing.
      await stats([row()], '/srv/dev/unknown');
      await w.deliver('filter.stats', { rows: [{ id: 'x' }] });
      const stored = await w.ctx.prisma.tokenSaverStat.findMany();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ projectId: w.b, runId: null });
    });
  });

  describe('the card view', () => {
    it('sums the round estimates at the session model input price', async () => {
      await price();
      const runId = await ranCard();
      await stats([
        // (4000 − 400) / 4 = 900 tokens
        row({ runId, runKind: 'card', filter: 'js/jest' }),
        // (2000 − 1000) / 4 = 250 tokens
        row({
          runId,
          runKind: 'card',
          filter: 'ops/git',
          rawBytes: 2_000,
          keptBytes: 1_000,
        }),
        row({
          runId,
          runKind: 'card',
          filter: 'none',
          rawBytes: 500,
          keptBytes: 500,
          passedThrough: true,
        }),
      ]);
      const card = await detail();
      const tokens = 900 + 250;
      expect(card.tokenSaved?.estimateTokens).toBe(tokens);
      expect(card.tokenSaved?.estimateUsd).toBeCloseTo(
        tokens * Number(INPUT_PRICE),
        12,
      );
      const [round] = card.rounds;
      expect(round.tokenSaved).toEqual(card.tokenSaved);
      expect(round.tokenSaverFilters?.map((f) => f.filter)).toEqual([
        'js/jest',
        'ops/git',
        'none',
      ]);
      expect(round.tokenSaverFilters?.[2]).toMatchObject({
        commands: 1,
        passedThrough: 1,
        estimateTokens: 0,
      });
    });

    it('is null with nothing filtered', async () => {
      await ranCard();
      const card = await detail();
      expect(card.tokenSaved).toBeNull();
      expect(card.artifactIncomplete).toBe(false);
      expect(card.rounds[0].tokenSaverFilters).toEqual([]);
    });
  });

  describe('artifactIncomplete from card.finish', () => {
    const finish = (sessionId: string, artifactIncomplete?: boolean) =>
      handlers.table['card.finish'](
        {
          summary: 'Done. Tests pass.',
          ...(artifactIncomplete === undefined ? {} : { artifactIncomplete }),
        },
        {
          runnerId: w.runnerId,
          requestId: 'lr_1',
          user: { id: w.operatorId, email: 'op@x.test', role: 'operator' },
          role: 'operator',
          project: {
            id: w.a,
            runnerId: w.runnerId,
            rootPath: '/srv/dev/widget',
            repo: 'acme/widget',
            displayName: 'widget',
            baseBranch: 'develop',
            baseOverride: null,
          },
          session: { runtime: 'claude', id: sessionId },
          via: 'mcp',
          ctx: { actor: { type: 'runner', runnerId: w.runnerId } },
          meta: { onBehalfOf: w.operatorId, via: 'mcp' },
        } satisfies LocalCall,
      );

    it('marks the round run and shows on the card', async () => {
      const runId = await ranCard();
      const { sessionId } = await w.card(1);
      await finish(sessionId as string, true);
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(run.artifactIncomplete).toBe(true);
      const card = await detail();
      expect(card.column).toBe('finished');
      expect(card.artifactIncomplete).toBe(true);
      expect(card.rounds[0].artifactIncomplete).toBe(true);
    });

    it('a complete finish marks nothing', async () => {
      const runId = await ranCard();
      const { sessionId } = await w.card(1);
      await finish(sessionId as string);
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(run.artifactIncomplete).toBe(false);
      expect((await detail()).artifactIncomplete).toBe(false);
    });
  });

  describe('the summary', () => {
    it('shows manual (/cs-eco) sessions as their own run kind (#475)', async () => {
      await stats([
        row({ runId: null, runKind: 'manual' }),
        row({ runId: null, runKind: 'orchestrator' }),
      ]);
      const stored = await w.ctx.prisma.tokenSaverStat.findMany({
        where: { runKind: 'manual' },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ projectId: w.a, runId: null });
      const body = (await w.viewer.get(summary())).body as TokenSaverSummary;
      expect(body.byRunKind.map((k) => k.runKind).sort()).toEqual([
        'manual',
        'orchestrator',
      ]);
      // A session without a run has no before/after.
      expect(body.beforeAfter).toEqual([]);
    });

    it('totals, rates, before/after by runs.tokenSaver, and the breakdowns', async () => {
      await price();
      const on = await ranCard();
      await w.ctx.prisma.run.update({
        where: { id: on },
        data: { tokenSaver: true, endedAt: new Date('2026-10-14T13:00:00Z') },
      });
      await stats([
        row({ runId: on, runKind: 'card' }),
        row({
          runId: on,
          runKind: 'card',
          filter: 'none',
          rawBytes: 100,
          keptBytes: 100,
          passedThrough: true,
          at: '2026-10-15T09:00:00.000Z',
        }),
        row({
          runKind: 'orchestrator',
          rawBytes: 100,
          keptBytes: 100,
          bypassed: true,
        }),
        // Outside the range.
        row({ runId: on, runKind: 'card', at: '2026-09-01T00:00:00.000Z' }),
      ]);
      const response = await w.viewer.get(summary());
      expect(response.status).toBe(200);
      const body = response.body as TokenSaverSummary;
      expect(body.totals).toMatchObject({
        commands: 3,
        rawBytes: 4_200,
        keptBytes: 600,
        estimateTokens: 900,
      });
      expect(body.totals.estimateUsd).toBeCloseTo(900 * Number(INPUT_PRICE));
      expect(body.bypassRate).toBeCloseTo(1 / 3);
      expect(body.passThroughRate).toBeCloseTo(1 / 3);
      expect(body.pivotAt).toBe('2026-09-01T00:00:00.000Z');
      expect(body.byDay.map((d) => d.day)).toEqual([
        '2026-10-14',
        '2026-10-15',
      ]);
      expect(body.byFilter[0]).toMatchObject({
        filter: 'js/jest',
        commands: 2,
        bypassed: 1,
      });
      expect(body.byRunKind.map((k) => k.runKind)).toEqual([
        'card',
        'orchestrator',
      ]);
      // The run is unpriced (no requests): counted, no average.
      expect(body.beforeAfter).toEqual([
        {
          runKind: 'card',
          beforeRuns: 0,
          beforeAvgUsd: null,
          afterRuns: 1,
          afterAvgUsd: null,
        },
      ]);
    });

    it('stores a row’s program and accepts one without it (#648)', async () => {
      await stats([
        row({
          filter: 'none:uncovered',
          program: 'git log',
          keptBytes: 4_000,
          passedThrough: true,
        }),
        row(),
      ]);
      const stored = await w.ctx.prisma.tokenSaverStat.findMany({
        orderBy: { id: 'asc' },
      });
      expect(stored.map((s) => s.program)).toEqual(['git log', null]);
      // An argument in the program fails the batch's schema: nothing stored.
      await stats([row({ program: 'cat /etc/passwd' })]);
      expect(await w.ctx.prisma.tokenSaverStat.count()).toBe(2);
    });

    it('lists the most frequent unfiltered programs, top 10 (#648)', async () => {
      const unfiltered = (
        program: string | undefined,
        filter = 'none:uncovered',
      ) =>
        row({
          filter,
          program,
          rawBytes: 100,
          keptBytes: 100,
          passedThrough: true,
        });
      await stats([
        ...Array.from({ length: 3 }, () => unfiltered('git log')),
        unfiltered('git log', 'none:compound'),
        unfiltered('ls', 'none'),
        unfiltered('ls', 'none:mode'),
        unfiltered(undefined, 'none'),
        // A filtered command never counts as unfiltered.
        row({ program: 'bun test' }),
        ...Array.from({ length: 10 }, (_, i) => unfiltered(`tool${i}`)),
      ]);
      const body = (await w.viewer.get(summary())).body as TokenSaverSummary;
      expect(body.unfilteredPrograms).toHaveLength(10);
      expect(body.unfilteredPrograms.slice(0, 3)).toEqual([
        { program: 'git log', commands: 4 },
        { program: 'ls', commands: 2 },
        { program: 'tool0', commands: 1 },
      ]);
      expect(body.unfilteredPrograms.map((p) => p.program)).not.toContain(
        'bun test',
      );
    });

    it('measures the prompt cache per run kind from usage, and names the runner version (#648)', async () => {
      const minute = (n: number) => new Date(Date.UTC(2026, 9, 14, 10, n));
      await w.ctx.prisma.runner.update({
        where: { id: w.runnerId },
        data: { version: '0.12.2' },
      });
      const runId = await ranCard();
      await w.ctx.prisma.run.update({
        where: { id: runId },
        data: { startedAt: minute(0), endedAt: minute(10) },
      });
      const card = await w.card(1);
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
      const request = (id: string, at: number) =>
        w.ctx.prisma.llmRequest.create({
          data: {
            sessionId: session.id,
            requestId: id,
            ts: minute(at),
            model: 'claude-opus-5-5',
            querySource: 'main',
            input: 100,
            output: 10,
            cacheRead: 700,
            cacheWrite5m: 150,
            cacheWrite1h: 50,
          },
        });
      await request('q1', 2);
      await request('q2', 8);
      await request('q3', 30); // after the run ended: not its own

      const body = (await w.viewer.get(summary())).body as TokenSaverSummary;
      expect(body.promptCache).toEqual([
        {
          runKind: 'card',
          runs: 1,
          input: 200,
          cacheRead: 1_400,
          cacheWrite: 400,
        },
      ]);
      expect(body.runnerVersion).toBe('0.12.2');
    });

    it('refuses a reversed or too long range', async () => {
      expect(
        (
          await w.viewer.get(
            summary(w.a, 'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z'),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await w.viewer.get(
            summary(w.a, 'from=2025-01-01T00:00:00Z&to=2026-10-01T00:00:00Z'),
          )
        ).status,
      ).toBe(400);
      expect((await w.viewer.get(summary(w.a, 'from=x&to=y'))).status).toBe(
        400,
      );
    });
  });
});
