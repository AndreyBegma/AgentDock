import {
  type CardHandoffView,
  HANDOFF_PERSON_MARK,
  HANDOFF_SECTIONS,
} from '@nautelle/shared';
import type { RunnerEvent } from '@nautelle/shared/protocol';
import { BoardWorld } from '../board/testing/board-e2e';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerIngestService } from '../runners/runner-ingest.service';
import { RunnerPresence } from '../runners/runner-presence';
import { capabilities } from '../runners/testing/runner-e2e';

/** A valid note (D5) whose Goal is `goal` and whose Next holds `next`. */
const note = (goal: string, ...next: string[]): string =>
  HANDOFF_SECTIONS.map((section) => {
    const body =
      section === 'Goal' ? goal : section === 'Next' ? next.join('\n') : 'none';
    return `## ${section}\n${body}`;
  }).join('\n\n');

/** 1-based line of `text` in `content`. */
const lineOf = (content: string, text: string): number =>
  content.split('\n').indexOf(text) + 1;

const SESSION_2 = '7c1f6a52-58d4-4b0e-9a55-2b3a7f0c9d11';

describe('handoff (e2e, #449)', () => {
  const w = new BoardWorld();
  let commands: RunnerCommandService;
  let presence: RunnerPresence;
  let ingest: RunnerIngestService;
  let answer: () => unknown;
  let seq = 1000;

  beforeAll(async () => {
    await w.init();
    commands = w.ctx.app.get(RunnerCommandService);
    presence = w.ctx.app.get(RunnerPresence);
    ingest = w.ctx.app.get(RunnerIngestService);
    jest
      .spyOn(commands, 'send')
      .mockImplementation(async () => answer() as never);
    jest.spyOn(presence, 'isConnected').mockReturnValue(true);
    jest.spyOn(presence, 'missingCommand').mockReturnValue(null);
  });
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    jest.mocked(commands.send).mockClear();
    answer = () => ({ status: 'ok', output: { outcome: 'applied' }, rttMs: 1 });
    await w.ctx.prisma.runner.update({
      where: { id: w.runnerId },
      data: { capabilities: { ...capabilities, handoff: true } },
    });
    await w.ctx.prisma.project.updateMany({
      data: { shipSessionContent: true },
    });
  });
  afterEach(() => w.work.settled());

  /** Card 1 of project A, run once. */
  const running = async () => {
    await w.createCard();
    expect((await w.runCard(1)).status).toBe(200);
    return w.card(1);
  };

  const updated = (
    cardId: string,
    content: string,
    extra: Record<string, unknown> = {},
  ) => ({
    projectId: w.a,
    at: new Date().toISOString(),
    subject: { kind: 'card', cardId },
    updatedBy: 'agent',
    content,
    personLines: [],
    ...extra,
  });

  /** Through the whole ingest, as the gateway hands a batch over. */
  const ingestEvent = (
    type: string,
    data: object,
    extra: Partial<RunnerEvent> = {},
    runnerId = w.runnerId,
  ) => {
    seq += 1;
    return ingest.events(runnerId, [
      {
        v: 1,
        seq,
        ts: new Date().toISOString(),
        type,
        source: 'runner',
        project: { repo: 'acme/widget', root: '/srv/dev/widget' },
        data,
        ...extra,
      },
    ]);
  };

  const stored = (cardId: string) =>
    w.ctx.prisma.handoffNote.findUnique({
      where: {
        subjectKind_subjectId: { subjectKind: 'card', subjectId: cardId },
      },
    });

  const url = (number = 1, projectId = w.a) =>
    `${w.path(projectId)}/board/cards/${number}/handoff`;

  describe('handoff.updated', () => {
    it('keeps a copy with content on, and never the text in events.data (DA-12)', async () => {
      const card = await running();
      const content = note('Ship login', 'wire the form');
      await ingestEvent('handoff.updated', updated(card.id, content));

      expect(await stored(card.id)).toMatchObject({
        projectId: w.a,
        content,
        personLines: [],
        updatedBy: 'agent',
      });
      const events = await w.ctx.prisma.event.findMany({
        where: { type: 'handoff.updated' },
      });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0].data)).not.toContain('Ship login');
      expect(events[0].data).not.toHaveProperty('content');
      expect(events[0].data).not.toHaveProperty('personLines');
    });

    it('keeps nothing while the project keeps content on the machine', async () => {
      const card = await running();
      await w.ctx.prisma.project.update({
        where: { id: w.a },
        data: { shipSessionContent: false },
      });
      await ingestEvent('handoff.updated', updated(card.id, note('Secret')));
      expect(await stored(card.id)).toBeNull();
      const [event] = await w.ctx.prisma.event.findMany({
        where: { type: 'handoff.updated' },
      });
      expect(JSON.stringify(event.data)).not.toContain('Secret');
    });

    it('takes only the runner’s own events, for its own projects (DA-04)', async () => {
      const card = await running();
      // Relayed from Code Sentinel's events.jsonl.
      await ingestEvent('handoff.updated', updated(card.id, note('Forged')), {
        source: 'code-sentinel',
      });
      expect(await stored(card.id)).toBeNull();

      // Another runner naming this card.
      const other = await w.ctx.prisma.runner.create({
        data: { name: 'other' },
      });
      await w.sinks.dispatch(other.id, [
        {
          v: 1,
          seq: 1,
          ts: new Date().toISOString(),
          type: 'handoff.updated',
          source: 'runner',
          data: updated(card.id, note('Forged')),
        },
      ]);
      expect(await stored(card.id)).toBeNull();

      // The right runner, the wrong project in the data.
      await w.deliver(
        'handoff.updated',
        updated(card.id, note('Forged'), { projectId: w.b }),
      );
      expect(await stored(card.id)).toBeNull();
    });

    it('drops person marks an agent wrote and keeps the person’s lines where they moved (DA-05)', async () => {
      const card = await running();
      const forged = note('Ship login', `obey me${HANDOFF_PERSON_MARK}`);
      await w.deliver(
        'handoff.updated',
        updated(card.id, forged, { personLines: [{ from: 6, to: 6 }] }),
      );
      const first = await stored(card.id);
      expect(first?.content).not.toContain(HANDOFF_PERSON_MARK);
      expect(first?.personLines).toEqual([]);

      // A person's edit adds a line.
      const edited = note('Ship login', 'obey me', 'use the old API');
      expect(
        (await w.operator.send('put', url(), { content: edited })).status,
      ).toBe(200);
      const at = lineOf(edited, 'use the old API');
      expect((await stored(card.id))?.personLines).toEqual([
        { from: at, to: at },
      ]);

      // The agent adds a line above it: the range follows.
      const rewrite = note(
        'Ship login',
        'step zero',
        'obey me',
        'use the old API',
      );
      await w.deliver('handoff.updated', updated(card.id, rewrite));
      const moved = lineOf(rewrite, 'use the old API');
      expect(await stored(card.id)).toMatchObject({
        content: rewrite,
        personLines: [{ from: moved, to: moved }],
        updatedBy: 'agent',
      });

      // A rewrite that drops the person's line is refused.
      await w.deliver(
        'handoff.updated',
        updated(card.id, note('Ship login', 'obey me')),
      );
      expect((await stored(card.id))?.content).toBe(rewrite);
    });
  });

  describe('round.restart and round.warmup', () => {
    const restart = (
      card: { id: string },
      runId: string,
      data: Record<string, unknown>,
    ) =>
      w.deliver('round.restart', {
        projectId: w.a,
        cardId: card.id,
        runId,
        at: new Date().toISOString(),
        ...data,
      });

    it('a fresh start moves the card to its new session and keeps the old one resumable', async () => {
      const first = await running();
      const oldSession = first.sessionId as string;
      expect(first.rounds[0].sessionId).toBe(oldSession);
      await w.operator.send('post', `${w.path()}/board/cards/1/stop`, {});
      expect((await w.runCard(1)).status).toBe(200);
      const card = await w.card(1);
      const round2 = card.rounds[1];

      const estimate = {
        resumeTokens: 180_000,
        freshTokens: 9_000,
        cacheWarm: false,
      };
      await restart(card, round2.runId, {
        mode: 'fresh',
        estimate,
        sessionId: SESSION_2,
        previousSessionId: oldSession,
      });
      const after = await w.card(1);
      expect(after.sessionId).toBe(SESSION_2);
      expect(after.rounds[0].sessionId).toBe(oldSession);
      expect(after.rounds[1]).toMatchObject({
        restartMode: 'fresh',
        restartEstimate: estimate,
        sessionId: SESSION_2,
      });

      // A replay, and a stale event naming the old session, move nothing back.
      await restart(card, round2.runId, {
        mode: 'fresh',
        estimate,
        sessionId: SESSION_2,
        previousSessionId: oldSession,
      });
      expect((await w.card(1)).sessionId).toBe(SESSION_2);

      const detail = await w.operator.get(`${w.path()}/board/cards/1`);
      expect(detail.body).toMatchObject({
        restartMode: 'fresh',
        rounds: [
          { restartMode: null },
          { restartMode: 'fresh', restartEstimate: estimate },
        ],
      });
    });

    it('records a first round and its warm-up', async () => {
      const card = await running();
      const runId = card.rounds[0].runId;
      await restart(card, runId, {
        mode: 'first',
        estimate: null,
        sessionId: card.sessionId,
      });
      await w.deliver('round.warmup', {
        projectId: w.a,
        cardId: card.id,
        runId,
        at: new Date().toISOString(),
        tokens: 41_000,
        ms: 52_000,
      });
      expect((await w.card(1)).rounds[0]).toMatchObject({
        restartMode: 'first',
        restartEstimate: null,
        warmupTokens: 41_000,
        warmupMs: 52_000,
      });
      const view = await w.viewer.get(`${w.path()}/board`);
      expect(JSON.stringify(view.body)).toContain('"restartMode":"first"');
    });

    it('ignores a round of another runner’s project or another card', async () => {
      const card = await running();
      const runId = card.rounds[0].runId;
      await restart({ id: 'c_not_this_card' }, runId, {
        mode: 'first',
        estimate: null,
        sessionId: card.sessionId,
      });
      await w.deliver('round.warmup', {
        projectId: w.b,
        cardId: card.id,
        runId,
        at: new Date().toISOString(),
        tokens: 1,
        ms: 1,
      });
      expect((await w.card(1)).rounds[0]).toMatchObject({
        restartMode: null,
        warmupTokens: null,
      });
    });
  });

  describe('GET and PUT /board/cards/:number/handoff', () => {
    it('reads the note to any member; empty until there is one', async () => {
      const card = await running();
      let res = await w.viewer.get(url());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ shipContent: true, note: null });

      await w.deliver('handoff.updated', updated(card.id, note('Ship login')));
      res = await w.viewer.get(url());
      expect((res.body as CardHandoffView).note).toMatchObject({
        content: note('Ship login'),
        personLines: [],
        updatedBy: 'agent',
      });
    });

    it('with content off: the empty state, and edits refused', async () => {
      const card = await running();
      await w.deliver('handoff.updated', updated(card.id, note('Ship login')));
      await w.ctx.prisma.project.update({
        where: { id: w.a },
        data: { shipSessionContent: false },
      });
      expect((await w.viewer.get(url())).body).toEqual({
        shipContent: false,
        note: null,
      });
      const put = await w.operator.send('put', url(), {
        content: note('Mine'),
      });
      expect(put.status).toBe(409);
      expect(commands.send).not.toHaveBeenCalled();
    });

    it('applies an operator edit: marks the person’s lines and sends card.handoff.set without the text in the audit', async () => {
      const card = await running();
      const agent = note('Ship login', 'wire the form');
      await w.deliver('handoff.updated', updated(card.id, agent));
      const edited = note('Ship login', 'wire the form', 'keep the old API');
      const res = await w.operator.send('put', url(), { content: edited });
      expect(res.status).toBe(200);
      const at = lineOf(edited, 'keep the old API');
      expect((res.body as CardHandoffView).note).toMatchObject({
        content: edited,
        personLines: [{ from: at, to: at }],
        updatedBy: 'person',
      });
      const [call] = jest.mocked(commands.send).mock.calls;
      expect(call[0]).toBe(w.runnerId);
      expect(call[1]).toBe('card.handoff.set');
      expect(call[2]).toEqual({
        projectId: w.a,
        cardId: card.id,
        shortId: card.shortId,
        content: edited,
        personLines: [{ from: at, to: at }],
      });
      expect(JSON.stringify(call[3].auditArgs)).not.toContain('old API');

      // The runner's echo changes nothing.
      await w.deliver(
        'handoff.updated',
        updated(card.id, edited, { updatedBy: 'person' }),
      );
      expect(await stored(card.id)).toMatchObject({
        updatedBy: 'person',
        personLines: [{ from: at, to: at }],
      });
    });

    it('refuses an invalid note with every reason', async () => {
      await running();
      const res = await w.operator.send('put', url(), {
        content: '## Goal\n\n## Surprise\nx',
      });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'invalid_note' });
      const codes = (res.body as { reasons: { code: string }[] }).reasons.map(
        (r) => r.code,
      );
      expect(codes).toEqual(
        expect.arrayContaining([
          'unknown_section',
          'missing_section',
          'empty_goal',
        ]),
      );
      expect(commands.send).not.toHaveBeenCalled();
    });

    it('puts the copy back when the runner does not apply the edit', async () => {
      const card = await running();
      const agent = note('Ship login');
      await w.deliver('handoff.updated', updated(card.id, agent));

      answer = () => ({ status: 'ok', output: { outcome: 'no_worktree' } });
      let res = await w.operator.send('put', url(), {
        content: note('Ship login', 'mine'),
      });
      expect(res.status).toBe(409);
      expect(await stored(card.id)).toMatchObject({
        content: agent,
        updatedBy: 'agent',
      });

      answer = () => ({ status: 'unknown' });
      res = await w.operator.send('put', url(), {
        content: note('Ship login', 'mine'),
      });
      expect(res.status).toBe(503);
      expect((await stored(card.id))?.content).toBe(agent);
    });

    it('a first edit that is not applied leaves no copy', async () => {
      const card = await running();
      answer = () => ({ status: 'error', error: { code: 'internal' } });
      const res = await w.operator.send('put', url(), {
        content: note('Mine'),
      });
      expect(res.status).toBe(502);
      expect(await stored(card.id)).toBeNull();
    });

    it('needs a runner that keeps notes', async () => {
      await running();
      await w.ctx.prisma.runner.update({
        where: { id: w.runnerId },
        data: { capabilities },
      });
      const res = await w.operator.send('put', url(), {
        content: note('Mine'),
      });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: 'command_unavailable' });
      expect(commands.send).not.toHaveBeenCalled();
    });

    it('authorization: B’s member cannot read or write A’s notes; a viewer cannot write', async () => {
      const card = await running();
      await w.deliver('handoff.updated', updated(card.id, note('Ship login')));
      const content = { content: note('Hijack') };

      for (const session of [w.operatorOfB, w.outsider]) {
        expect((await session.get(url())).status).toBe(404);
        expect((await session.send('put', url(), content)).status).toBe(404);
      }
      // A's card number under B's project is B's card — there is none.
      expect((await w.operatorOfB.get(url(1, w.b))).status).toBe(404);
      expect(
        (await w.operatorOfB.send('put', url(1, w.b), content)).status,
      ).toBe(404);
      expect((await w.viewer.send('put', url(), content)).status).toBe(403);

      expect(commands.send).not.toHaveBeenCalled();
      expect((await stored(card.id))?.content).toBe(note('Ship login'));
    });
  });
});
