import type {
  BoardCardDetail,
  FilterStatRow,
  TokenSaverSettingsView,
  TokenSaverSummary,
} from '@nautelle/shared';
import { BoardWorld, ROOT_B } from '../board/testing/board-e2e';
import { usageByRun } from '../history/run-usage';
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

  describe('a /cs-eco session (#748)', () => {
    /** A Claude session of `projectId`'s runner, as its hooks would leave it. */
    const session = async (
      externalId: string,
      projectId: string | null = w.a,
      model: string | null = 'claude-haiku-5-5',
    ) => {
      const created = await w.ctx.prisma.agentSession.create({
        data: {
          runnerId: w.runnerId,
          runtime: 'claude',
          externalId,
          projectId,
          cwd: '/srv/dev/widget',
          origin: 'manual',
          models: model === null ? [] : [model],
          startedAt: new Date('2026-10-14T11:00:00Z'),
          lastEventAt: new Date('2026-10-14T13:00:00Z'),
        },
      });
      if (model !== null) {
        await w.ctx.prisma.llmRequest.create({
          data: {
            sessionId: created.id,
            requestId: `q_${externalId}`,
            ts: new Date('2026-10-14T13:00:00Z'),
            model,
            querySource: 'main',
          },
        });
      }
      return created.id;
    };

    /** A terminal card of project A tracked to `sessionId`. */
    const terminalCard = (sessionId: string) =>
      w.ctx.prisma.boardCard.create({
        data: {
          projectId: w.a,
          number: 1,
          shortId: 'term0001',
          title: 'Terminal work',
          column: 'in_progress',
          position: 1,
          source: 'terminal',
          trackedSessionId: sessionId,
          issueOnRun: false,
          specOnRun: false,
          movedAt: new Date(),
        },
      });

    const manual = (over: Partial<FilterStatRow> = {}) =>
      row({ runKind: 'manual', ...over });

    const eco = (rows: FilterStatRow[], session?: string, root?: string) =>
      w.deliver(
        'filter.stats',
        { rows, ...(session === undefined ? {} : { session }) },
        root ? { project: { repo: 'acme/gadget', root } } : {},
      );

    it('stores the session of the same runner and project on every row', async () => {
      const id = await session('sess-a');
      await eco([manual(), manual()], 'sess-a');
      const stored = await w.ctx.prisma.tokenSaverStat.findMany();
      expect(stored).toHaveLength(2);
      for (const s of stored) {
        expect(s).toMatchObject({
          sessionId: id,
          sessionExternalId: 'sess-a',
        });
      }
    });

    it('keeps no session of another project or an unknown one, only its external id', async () => {
      await session('sess-b', w.b);
      await eco([manual()], 'sess-b');
      await eco([manual()], 'sess-unknown');
      const stored = await w.ctx.prisma.tokenSaverStat.findMany();
      expect(stored).toHaveLength(2);
      expect(stored.every((s) => s.sessionId === null)).toBe(true);
      expect(stored.map((s) => s.sessionExternalId).sort()).toEqual([
        'sess-b',
        'sess-unknown',
      ]);
    });

    it('skips a batch with a session and a non-manual row, storing nothing', async () => {
      await session('sess-a');
      await w.deliver('filter.stats', {
        rows: [manual(), row({ runKind: 'orchestrator' })],
        session: 'sess-a',
      });
      expect(await w.ctx.prisma.tokenSaverStat.count()).toBe(0);
    });

    it('stores an older runner’s batch, without a session, as before', async () => {
      await eco([manual()]);
      const [stored] = await w.ctx.prisma.tokenSaverStat.findMany();
      expect(stored).toMatchObject({
        sessionId: null,
        sessionExternalId: null,
      });
    });

    it('counts on the card the session is tracked to, priced at the session model', async () => {
      await price();
      const id = await session('sess-a');
      await terminalCard(id);
      await eco(
        [
          manual({ rawBytes: 4_000, keptBytes: 400 }),
          manual({ filter: 'ops/git', rawBytes: 2_000, keptBytes: 1_000 }),
        ],
        'sess-a',
      );
      const view = await detail();
      expect(view.tokenSaved?.estimateTokens).toBe(900 + 250);
      expect(view.tokenSaved?.estimateUsd).toBeGreaterThan(0);
    });

    it('counts a row stored before its session was known, once the session is', async () => {
      await price();
      await eco([manual()], 'sess-late');
      const id = await session('sess-late');
      await terminalCard(id);
      expect((await detail()).tokenSaved?.estimateTokens).toBe(900);
    });

    it("never reaches a card of another project from that project's root", async () => {
      await price();
      const id = await session('sess-a');
      await terminalCard(id);
      // Q's root names P's session: the row is B's, with no session.
      await eco([manual()], 'sess-a', ROOT_B);
      const [stored] = await w.ctx.prisma.tokenSaverStat.findMany();
      expect(stored).toMatchObject({ projectId: w.b, sessionId: null });
      expect((await detail()).tokenSaved).toBeNull();
    });

    it('prices an untracked manual session on the summary, and not into another project', async () => {
      await price();
      await session('sess-a');
      await eco([manual()], 'sess-a');
      await eco([manual()], 'sess-a', ROOT_B);
      const a = (await w.viewer.get(summary())).body as TokenSaverSummary;
      const manualA = a.byRunKind.find((k) => k.runKind === 'manual');
      expect(manualA?.estimateTokens).toBe(900);
      expect(manualA?.estimateUsd).toBeGreaterThan(0);
      // B's row names A's session, which is not B's: tokens only, no price.
      const b = (await w.operatorOfB.get(summary(w.b)))
        .body as TokenSaverSummary;
      const manualB = b.byRunKind.find((k) => k.runKind === 'manual');
      expect(manualB).toMatchObject({ estimateTokens: 900, estimateUsd: 0 });
      expect((await w.operatorOfB.get(summary(w.a))).status).toBe(404);
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

    describe('cost per round (#663 D5)', () => {
      const at = (day: number, hour: number, minute = 0) =>
        new Date(Date.UTC(2026, 9, day, hour, minute));

      const claudeSession = (externalId: string) =>
        w.ctx.prisma.agentSession.create({
          data: {
            runnerId: w.runnerId,
            runtime: 'claude',
            externalId,
            cwd: '/srv/dev/.wt-widget-card-x',
            origin: 'run',
            startedAt: at(1, 0),
            lastEventAt: at(30, 0),
          },
        });

      let requestSeq = 0;
      const request = (
        sessionId: string,
        ts: Date,
        over: Partial<{
          costUsd: string | null;
          turnId: string | null;
          querySource: 'main' | 'subagent';
          input: number;
          cacheRead: number;
          cacheWrite5m: number;
          cacheWrite1h: number;
        }> = {},
      ) => {
        requestSeq += 1;
        return w.ctx.prisma.llmRequest.create({
          data: {
            sessionId,
            requestId: `req_${requestSeq}`,
            ts,
            model: 'claude-opus-5-5',
            querySource: 'main',
            input: 100,
            output: 10,
            cacheRead: 800,
            cacheWrite5m: 100,
            cacheWrite1h: 0,
            costUsd: '0.100000',
            ...over,
          },
        });
      };

      const turn = (sessionId: string, promptId: string, startedAt: Date) =>
        w.ctx.prisma.turn.create({
          data: { sessionId, promptId, startedAt },
        });

      /** A further round of card 1, with its own run in `[start, end]`. */
      const extraRound = async (
        round: number,
        trigger: 'feedback' | 'ci_fix',
        start: Date,
        end: Date,
      ) => {
        const card = await w.card(1);
        const run = await w.ctx.prisma.run.create({
          data: {
            kind: 'card',
            projectId: w.a,
            status: 'succeeded',
            triggeredByType: 'user',
            startedAt: start,
            endedAt: end,
            updatedAt: end,
          },
        });
        await w.ctx.prisma.boardCardRound.create({
          data: {
            cardId: card.id,
            round,
            runId: run.id,
            trigger,
            cardTitle: card.title,
            cardBody: card.body,
            cardKind: 'feature',
          },
        });
        return run.id;
      };

      it('measures each session kind per week: median, p90, cache share, peak and turns', async () => {
        const first = await ranCard();
        await w.ctx.prisma.run.update({
          where: { id: first },
          data: { startedAt: at(13, 10), endedAt: at(13, 11) },
        });
        await extraRound(2, 'feedback', at(14, 10), at(14, 11));
        await extraRound(3, 'feedback', at(15, 10), at(15, 11));
        await extraRound(4, 'ci_fix', at(15, 12), at(15, 13));
        // The next ISO week (Monday 2026-10-19).
        await extraRound(5, 'feedback', at(20, 10), at(20, 11));
        const card = await w.card(1);
        const session = await claudeSession(card.sessionId as string);

        // Round 1: two turns, $0.10 + $0.10; the larger request is the peak.
        const t1 = await turn(session.id, 'p1', at(13, 10, 1));
        const t2 = await turn(session.id, 'p2', at(13, 10, 5));
        await request(session.id, at(13, 10, 2), { turnId: t1.id });
        await request(session.id, at(13, 10, 6), {
          turnId: t2.id,
          cacheRead: 5_000,
        });
        // Rounds 2 and 3: one request each, no turn named — one main request.
        await request(session.id, at(14, 10, 2), { costUsd: '0.400000' });
        await request(session.id, at(15, 10, 2), { costUsd: '1.000000' });
        await request(session.id, at(15, 10, 3), {
          querySource: 'subagent',
          costUsd: '0.000000',
        });
        // Round 4 (CI fix): unpriced.
        await request(session.id, at(15, 12, 2), { costUsd: null });
        await request(session.id, at(20, 10, 2));

        const body = (await w.viewer.get(summary())).body as TokenSaverSummary;
        const card13 = body.costPerRound.find(
          (r) => r.sessionKind === 'card' && r.week === '2026-10-12',
        );
        // Round costs 0.20, 0.40, 1.00: median 0.40, p90 0.40 + 0.8 × 0.60.
        expect(card13).toEqual({
          sessionKind: 'card',
          week: '2026-10-12',
          rounds: 3,
          pricedRounds: 3,
          medianUsd: '0.400000',
          p90Usd: '0.880000',
          cacheReadShare: expect.any(Number),
          medianPeakContext: 1_000,
          medianTurns: 1,
        });
        // 800 × 4 + 5 000 read of 1 000 × 4 + 5 000 + 800 … every input token.
        const reads = 800 * 4 + 5_000;
        expect(card13?.cacheReadShare).toBeCloseTo(reads / (reads + 200 * 5));
        expect(
          body.costPerRound.map((r) => [r.sessionKind, r.week, r.rounds]),
        ).toEqual([
          ['card', '2026-10-12', 3],
          ['card', '2026-10-19', 1],
          ['ci_fix', '2026-10-12', 1],
        ]);
        expect(
          body.costPerRound.find((r) => r.sessionKind === 'ci_fix'),
        ).toMatchObject({ pricedRounds: 0, medianUsd: null, p90Usd: null });
      });

      it('counts a card design turn in the card’s design session', async () => {
        await w.createCard();
        const card = await w.card(1);
        const designSessionId = '00000000-0000-4000-8000-000000000663';
        await w.ctx.prisma.boardCard.update({
          where: { id: card.id },
          data: { designSessionId },
        });
        const run = await w.ctx.prisma.run.create({
          data: {
            kind: 'plan',
            projectId: w.a,
            status: 'succeeded',
            triggeredByType: 'user',
            startedAt: at(14, 9),
            endedAt: at(14, 10),
            updatedAt: at(14, 10),
          },
        });
        await w.ctx.prisma.planTurn.create({
          data: { cardId: card.id, runId: run.id, action: 'design', input: {} },
        });
        const session = await claudeSession(designSessionId);
        await request(session.id, at(14, 9, 10), { costUsd: '0.250000' });
        await request(session.id, at(14, 9, 20), { costUsd: '0.250000' });

        const body = (await w.viewer.get(summary())).body as TokenSaverSummary;
        expect(body.costPerRound).toEqual([
          expect.objectContaining({
            sessionKind: 'design',
            week: '2026-10-12',
            rounds: 1,
            medianUsd: '0.500000',
            medianTurns: 2,
          }),
        ]);
        // The run's own usage counts the design session too (it had none).
        const usage = await usageByRun(w.ctx.prisma, [run.id]);
        expect(usage.get(run.id)).toMatchObject({
          requests: 2,
          costUsd: '0.500000',
        });
      });

      it('measures the assistant chat reply by reply, for its project only', async () => {
        const call = (costUsd: string, cacheRead: number) =>
          w.ctx.prisma.llmCall.create({
            data: {
              ts: at(14, 9),
              provider: 'anthropic',
              model: 'claude-sonnet-5-5',
              feature: 'assistant',
              outcome: 'ok',
              input: 1_000,
              cacheRead,
              costUsd,
              priceVersion: 1,
              durationMs: 1,
            },
          });
        const reply = async (projectId: string, calls: string[]) => {
          const conversation = await w.ctx.prisma.assistantConversation.create({
            data: { userId: w.operatorId, projectId },
          });
          await w.ctx.prisma.assistantMessage.create({
            data: {
              conversationId: conversation.id,
              role: 'assistant',
              content: 'Done.',
              displayContent: 'Done.',
              language: 'en',
              llmCallIds: calls,
              createdAt: at(14, 9),
            },
          });
        };
        const a = await call('0.010000', 0);
        const b = await call('0.030000', 3_000);
        await reply(w.a, [a.id, b.id]);
        await reply(w.b, [(await call('9.000000', 0)).id]);

        const body = (await w.viewer.get(summary())).body as TokenSaverSummary;
        expect(body.costPerRound).toEqual([
          {
            sessionKind: 'assistant',
            week: '2026-10-12',
            rounds: 1,
            pricedRounds: 1,
            medianUsd: '0.040000',
            p90Usd: '0.040000',
            cacheReadShare: 3_000 / 5_000,
            medianPeakContext: 4_000,
            medianTurns: 2,
          },
        ]);
      });

      it('a member of another project cannot read it', async () => {
        expect((await w.operatorOfB.get(summary(w.a))).status).toBe(404);
        expect((await w.outsider.get(summary(w.a))).status).toBe(404);
      });
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
