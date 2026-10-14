import { type BoardCardDetail, CARD_CONTINUE_PROMPT } from '@agentdock/shared';
import { BudgetGate } from '../budgets/budget-gate';
import { BoardWorld, failed } from './testing/board-e2e';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('board rounds (e2e)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const post = (number: number, action: string, body: object = {}) =>
    w.operator.send(
      'post',
      `${w.path()}/board/cards/${number}/${action}`,
      body,
    );

  describe('Run', () => {
    it('creates round 1 and a card run, sends card.run with a fresh uuid and the D5 branch, and moves to In progress', async () => {
      await w.createCard({ title: 'Add login!' });
      const response = await w.runCard(1);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        column: 'in_progress',
        branch: 'card/c1-add-login',
        round: { round: 1, phase: 'starting' },
      });

      const card = await w.card(1);
      expect(card.sessionId).toMatch(UUID);
      expect(card.rounds).toHaveLength(1);
      expect(card.rounds[0]).toMatchObject({
        round: 1,
        trigger: 'run',
        phase: 'starting',
        tmuxSession: `agentdock-card-${card.shortId}`,
      });
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: card.rounds[0].runId },
      });
      expect(run).toMatchObject({
        kind: 'card',
        projectId: w.a,
        status: 'running',
        runtime: 'claude',
        model: 'opus',
        profileKey: 'claude-main',
        triggeredByType: 'user',
        triggeredById: w.operatorId,
      });

      const [sent] = w.sent('card.run');
      expect(sent).toMatchObject({
        cardId: card.id,
        runId: run.id,
        projectId: w.a,
        root: '/srv/dev/widget',
        base: 'develop',
        shortId: card.shortId,
        branch: 'card/c1-add-login',
        session: { id: card.sessionId, resume: false },
        profileKey: 'claude-main',
        model: 'opus',
        permissionMode: 'auto',
      });
      expect(sent.prompt).toContain('C-1');
      expect(sent).not.toHaveProperty('files');
      // The prompt is the card's text: the audit keeps its length only.
      const [started] = await w.audit('card.run_started');
      expect(started.result).toBe('ok');
    });

    it('gives every card its own session uuid', async () => {
      await w.createCard();
      await w.createCard();
      await w.runCard(1);
      await w.runCard(2);
      const [a, b] = w.sent('card.run');
      expect((a.session as { id: string }).id).not.toBe(
        (b.session as { id: string }).id,
      );
    });

    it('takes the model of the request and keeps it on the card', async () => {
      await w.createCard();
      await w.runCard(1, { model: 'sonnet' });
      expect(w.sent('card.run')[0].model).toBe('sonnet');
      expect((await w.card(1)).model).toBe('sonnet');
    });

    it('refuses bypassPermissions without admin', async () => {
      await w.createCard();
      const response = await w.runCard(1, {
        permissionMode: 'bypassPermissions',
      });
      expect(response.status).toBe(403);
      expect(w.sent('card.run')).toEqual([]);
    });

    it('refuses a running card with 409 card_running', async () => {
      await w.createCard();
      await w.runCard(1);
      const again = await w.runCard(1);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('card_running');
    });

    it('a hard-stop budget → 409 budget_exceeded, nothing created', async () => {
      const gate = w.ctx.app.get(BudgetGate);
      const check = jest.spyOn(gate, 'check').mockResolvedValue({
        allowed: false,
        budgetId: 'b1',
        scope: 'project',
        resetsAt: new Date('2026-11-01T00:00:00Z'),
      });
      try {
        await w.createCard();
        const response = await w.runCard(1);
        expect(response.status).toBe(409);
        expect(response.body.error).toBe('budget_exceeded');
        expect((await w.card(1)).rounds).toEqual([]);
        expect(w.sent('card.run')).toEqual([]);
      } finally {
        check.mockRestore();
      }
    });

    it('a 4th concurrent run → 409 max_running', async () => {
      for (let i = 0; i < 4; i += 1) await w.createCard();
      const responses = await Promise.all(
        [1, 2, 3, 4].map((n) => w.runCard(n)),
      );
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 200, 409]);
      expect(responses.find((r) => r.status === 409)?.body.error).toBe(
        'max_running',
      );
      expect(
        await w.ctx.prisma.boardCardRound.count({
          where: {
            phase: { in: ['queued', 'starting', 'running', 'waiting'] },
          },
        }),
      ).toBe(3);
    });

    it('is 503 command_unavailable when the runner cannot take card.run', async () => {
      w.offline = true;
      await w.createCard();
      const response = await w.runCard(1);
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('command_unavailable');
      expect((await w.card(1)).rounds).toEqual([]);
    });

    it('a runner refusal fails the round and its run', async () => {
      w.handlers['card.run'] = () => failed('internal');
      await w.createCard();
      const response = await w.runCard(1);
      expect(response.status).toBe(502);
      const card = await w.card(1);
      expect(card.rounds[0].phase).toBe('failed');
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: card.rounds[0].runId },
      });
      expect(run.status).toBe('failed');

      // A retry of a round that never started starts the session again.
      w.handlers['card.run'] = undefined;
      expect((await w.runCard(1)).status).toBe(200);
      expect(w.sent('card.run')[1]).toMatchObject({
        session: { id: card.sessionId, resume: false },
      });
    });

    it('a retry after a stop resumes the session with "continue"', async () => {
      await w.createCard();
      await w.runCard(1);
      await post(1, 'stop');
      expect((await w.runCard(1)).status).toBe(200);
      const card = await w.card(1);
      expect(card.rounds.map((r) => r.round)).toEqual([1, 2]);
      expect(w.sent('card.run')[1]).toMatchObject({
        session: { id: card.sessionId, resume: true },
        prompt: CARD_CONTINUE_PROMPT,
      });
    });
  });

  describe('feedback', () => {
    it('creates round k+1 resuming the session and returns the card to In progress', async () => {
      await w.createCard();
      await w.runCard(1);
      await post(1, 'finish');
      expect((await w.card(1)).column).toBe('finished');

      const response = await post(1, 'feedback', {
        text: 'Rename the button.',
      });
      expect(response.status).toBe(200);
      const card = await w.card(1);
      expect(card.column).toBe('in_progress');
      expect(card.rounds[1]).toMatchObject({
        round: 2,
        trigger: 'feedback',
        feedback: 'Rename the button.',
        authorId: w.operatorId,
      });
      expect(w.sent('card.run')[1]).toMatchObject({
        session: { id: card.sessionId, resume: true },
        branch: card.branch,
        prompt:
          'Review feedback: Rename the button.\n\nAddress it on the same branch, commit, then call finish_card.',
      });
      expect(w.sent('card.run')[1]).not.toHaveProperty('files');
    });

    it('is 409 while a round is active, and outside Finished', async () => {
      await w.createCard();
      const fresh = await post(1, 'feedback', { text: 'x' });
      expect(fresh.status).toBe(409);
      expect(fresh.body.error).toBe('wrong_column');

      await w.runCard(1);
      const active = await post(1, 'feedback', { text: 'x' });
      expect(active.status).toBe(409);
      expect(active.body.error).toBe('card_running');
    });
  });

  describe('issue and spec (D2)', () => {
    it('issueOnRun creates an unqueued issue and names the branch after it', async () => {
      await w.createCard({ issueOnRun: true, kind: 'bug', title: 'Crash' });
      expect((await w.runCard(1)).status).toBe(200);
      const [issue] = w.issues();
      expect(issue).toMatchObject({
        projectId: w.a,
        title: 'Crash',
        labels: ['bug'],
        queue: false,
      });
      expect(issue).not.toHaveProperty('readyLabel');
      expect(issue.body).toContain(
        'Tracked on AgentDock board card C-1 — worked by a dedicated worker, not queued for the orchestrator.',
      );
      const card = await w.card(1);
      expect(card).toMatchObject({
        issueNumber: 41,
        issueUrl: 'https://github.com/acme/widget/issues/41',
        branch: 'fix/41-crash',
      });
      expect(w.sent('card.run')[0].prompt).toContain('#41');
    });

    it('specOnRun without a specDir → 422 no_spec_dir', async () => {
      await w.createCard({ specOnRun: true });
      const response = await w.runCard(1);
      expect(response.status).toBe(422);
      expect(response.body.error).toBe('no_spec_dir');
      expect(w.sent('card.run')).toEqual([]);
    });

    it('specOnRun with a specDir commits the spec first', async () => {
      await w.ctx.prisma.project.update({
        where: { id: w.a },
        data: {
          codeSentinelConfig: { orchestrator: { specDir: 'docs/specs' } },
        },
      });
      await w.createCard({ specOnRun: true });
      await w.runCard(1);
      const [sent] = w.sent('card.run');
      expect(sent.files).toEqual([
        {
          path: 'docs/specs/card-1-add-login.md',
          content: expect.stringContaining('# C-1: Add login'),
        },
      ]);
      expect(sent.prompt).toContain('docs/specs/card-1-add-login.md');
      expect((await w.card(1)).specPath).toBe('docs/specs/card-1-add-login.md');
    });
  });

  it("costs each round by its run's window over the card's one session", async () => {
    const minute = (n: number) => new Date(Date.UTC(2026, 9, 14, 10, n));
    await w.createCard();
    await w.runCard(1);
    await post(1, 'finish');
    await post(1, 'feedback', { text: 'Again.' });
    const card = await w.card(1);
    const [first, second] = card.rounds;
    // Round 1 ran 10:00–10:10, round 2 runs since 10:20.
    await w.ctx.prisma.run.update({
      where: { id: first.runId },
      data: { startedAt: minute(0), endedAt: minute(10) },
    });
    await w.ctx.prisma.run.update({
      where: { id: second.runId },
      data: { startedAt: minute(20) },
    });
    // The card worktree sits outside the project root: no projectId.
    const session = await w.ctx.prisma.agentSession.create({
      data: {
        runnerId: w.runnerId,
        runtime: 'claude',
        externalId: card.sessionId as string,
        cwd: '/srv/dev/.wt-widget-card-x',
        origin: 'run',
        startedAt: minute(0),
        lastEventAt: minute(25),
      },
    });
    const request = (id: string, at: number, costUsd: string) =>
      w.ctx.prisma.llmRequest.create({
        data: {
          sessionId: session.id,
          requestId: id,
          ts: minute(at),
          model: 'claude-opus-5-5',
          querySource: 'main',
          input: 100,
          output: 10,
          costUsd,
        },
      });
    await request('q1', 2, '1.000000');
    await request('q2', 8, '0.500000');
    await request('q3', 15, '9.000000'); // between the rounds: neither's
    await request('q4', 25, '0.250000');

    const detail = (await w.operator.get(`${w.path()}/board/cards/1`))
      .body as BoardCardDetail;
    expect(detail.rounds.map((r) => r.costUsd)).toEqual([
      '1.500000',
      '0.250000',
    ]);
    expect(detail.costUsd).toBe('1.750000');
  });

  it('a Codex default profile → 422 unsupported_runtime', async () => {
    const codex = await w.ctx.prisma.runtimeProfile.create({
      data: {
        runnerId: w.runnerId,
        key: 'codex-main',
        runtime: 'codex',
        label: 'Codex',
        env: {},
        args: [],
        authenticated: true,
      },
    });
    await w.ctx.prisma.project.update({
      where: { id: w.a },
      data: { defaultProfileId: codex.id },
    });
    await w.createCard();
    const response = await w.runCard(1);
    expect(response.status).toBe(422);
    expect(response.body.error).toBe('unsupported_runtime');
  });

  it('records card.run_started as an error when the runner refuses', async () => {
    w.handlers['card.run'] = () => failed('internal');
    await w.createCard();
    await w.runCard(1);
    const [record] = await w.audit('card.run_started');
    expect(record.result).toBe('error');
  });
});
