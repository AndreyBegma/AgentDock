import type {
  CardDecidingSignal,
  CardEffort,
  CardWorkClass,
} from '@nautelle/shared';
import { cardAssessHash } from '../assess/assess-input';
import { capabilities } from '../runners/testing/runner-e2e';
import { BoardRoundsService, CardNotEscalatable } from './board-rounds.service';
import { BoardWorld } from './testing/board-e2e';

/**
 * #750 (ADR-0076): model and effort by card class in the B arm of
 * `model-by-type`, the session lock in both arms, and the escalation to Opus.
 */
describe('board model by card class (e2e, #750)', () => {
  const w = new BoardWorld();
  let rounds: BoardRoundsService;

  beforeAll(async () => {
    await w.init();
    rounds = w.ctx.app.get(BoardRoundsService);
  });
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  /** The runner advertises effort, the forced fresh start and the escalation. */
  const advertise = (
    over: Partial<{ cardFreshStart: boolean; cardEscalate: boolean }> = {},
  ) =>
    w.ctx.prisma.runner.update({
      where: { id: w.runnerId },
      data: {
        capabilities: {
          ...capabilities,
          cardEffort: true,
          cardFreshStart: true,
          cardEscalate: true,
          ...over,
        },
      },
    });

  /**
   * A card assessed as `workClass` with `signals` — current, so its hash is
   * what the assessor reads for it now (a fresh card: no attachment, no
   * design, no feedback).
   */
  const classified = async (
    workClass: CardWorkClass,
    effort: CardEffort = 'low',
    signals: CardDecidingSignal[] = [],
  ) => {
    const card = await w.createCard();
    await assess(card.number, workClass, effort, signals);
    return card;
  };

  const assess = async (
    number: number,
    workClass: CardWorkClass,
    effort: CardEffort = 'low',
    signals: CardDecidingSignal[] = [],
  ) => {
    const card = await w.card(number);
    await w.ctx.prisma.boardCard.update({
      where: { id: card.id },
      data: {
        recommendedModel: 'haiku',
        recommendedEffort: effort,
        recommendedReason: 'Fits haiku.',
        recommendedDesignModel: 'sonnet',
        recommendedDesignReason: 'Fits sonnet.',
        workClass,
        workSignals: signals,
        assessedAt: new Date(),
        assessmentHash: cardAssessHash({
          title: card.title,
          body: card.body,
          kind: card.kind,
          attachments: [],
          designApproved: false,
          feedback: null,
        }),
      },
    });
  };

  const stop = (number: number) =>
    w.operator.send('post', `${w.path()}/board/cards/${number}/stop`, {});

  const runOf = async (number: number, index: number) => {
    const card = await w.card(number);
    return w.ctx.prisma.run.findUniqueOrThrow({
      where: { id: card.rounds[index].runId },
    });
  };

  const escalate = async (
    number: number,
    reason: 'misclassified' | 'gave_up' = 'misclassified',
  ) => {
    const card = await w.card(number);
    return rounds.escalateByWorker(
      { id: w.a, runnerId: w.runnerId },
      card.sessionId ?? '',
      reason,
      'The card needs a schema decision.',
    );
  };

  /** The relaunch starts once the answer is out; wait for its round. */
  const roundCount = async (number: number, count: number) => {
    for (let i = 0; i < 100; i += 1) {
      if ((await w.card(number)).rounds.length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`card ${number} never reached ${count} rounds`);
  };

  describe('launch defaults (D3, D4)', () => {
    it('runs a mechanical card on sonnet at the assessed effort in the B arm, and on the recommendation in the A arm', async () => {
      await advertise();
      await w.modelByType('on');
      const b = await classified('mechanical', 'high');
      expect((await w.runCard(b.number)).status).toBe(200);
      expect(w.sent('card.run')[0]).toMatchObject({
        model: 'sonnet',
        effort: 'medium',
      });

      await w.modelByType('off');
      const a = await classified('mechanical', 'low');
      expect((await w.runCard(a.number)).status).toBe(200);
      expect(w.sent('card.run')[1]).toMatchObject({
        model: 'haiku',
        effort: 'low',
      });
      expect(w.sent('card.run')[1]).not.toHaveProperty('escalate');
    });

    it('runs a deciding card on opus at high, and shows the mapped pair on the card', async () => {
      await advertise();
      await w.modelByType('on');
      const { number } = await classified('deciding', 'low', ['auth']);
      const detail = await w.operator.get(`${w.path()}/board/cards/${number}`);
      expect(detail.body.recommendation.work).toMatchObject({
        model: 'opus',
        effort: 'high',
        class: 'deciding',
        signals: ['auth'],
      });
      expect((await w.runCard(number)).status).toBe(200);
      expect(w.sent('card.run')[0]).toMatchObject({
        model: 'opus',
        effort: 'high',
      });
      expect(w.sent('card.run')[0]).not.toHaveProperty('escalate');
    });

    it('runs a card with no or a stale assessment on opus at medium', async () => {
      await advertise();
      await w.modelByType('on');
      const none = await w.createCard();
      expect((await w.runCard(none.number)).status).toBe(200);
      expect(w.sent('card.run')[0]).toMatchObject({
        model: 'opus',
        effort: 'medium',
      });

      const stale = await classified('mechanical');
      await w.ctx.prisma.boardCard.update({
        where: { id: stale.id },
        data: { body: 'Users sign in with a passkey.' },
      });
      expect((await w.runCard(stale.number)).status).toBe(200);
      expect(w.sent('card.run')[1]).toMatchObject({
        model: 'opus',
        effort: 'medium',
      });
    });

    it('a person’s choice wins over the mapping and is stored only when it differs (D5)', async () => {
      await advertise();
      await w.modelByType('on');
      const { number } = await classified('mechanical');
      expect((await w.runCard(number, { model: 'sonnet' })).status).toBe(200);
      expect((await w.card(number)).model).toBeNull();
      await stop(number);
      expect((await w.runCard(number, { model: 'opus' })).status).toBe(200);
      expect((await w.card(number)).model).toBe('opus');
      expect((await runOf(number, 1)).model).toBe('opus');
    });
  });

  describe('the session lock (D7)', () => {
    it('starts a fresh session when the model changes, and stores the new pair', async () => {
      await advertise();
      await w.modelByType('on');
      const { number } = await classified('mechanical');
      await w.runCard(number);
      expect(w.sent('card.run')[0]).toMatchObject({
        model: 'sonnet',
        effort: 'low',
        session: { resume: false },
      });
      expect(await w.card(number)).toMatchObject({
        sessionModel: 'sonnet',
        sessionEffort: 'low',
      });
      await stop(number);
      expect((await w.runCard(number, { model: 'opus' })).status).toBe(200);
      expect(w.sent('card.run')[1]).toMatchObject({
        model: 'opus',
        session: { resume: true, fresh: true },
      });
      expect((await w.card(number)).sessionModel).toBe('opus');
    });

    it('resumes when the pair is the same, in the A arm too', async () => {
      await advertise();
      const { number } = await classified('mechanical');
      await w.runCard(number);
      await stop(number);
      await w.runCard(number);
      expect(w.sent('card.run')[1]).toMatchObject({
        session: { resume: true },
      });
      expect(w.sent('card.run')[1].session).not.toHaveProperty('fresh');
    });

    it('resumes a card from before #750 (a null pair)', async () => {
      await advertise();
      const { id, number } = await classified('mechanical');
      await w.runCard(number);
      await stop(number);
      await w.ctx.prisma.boardCard.update({
        where: { id },
        data: { sessionModel: null, sessionEffort: null },
      });
      await w.runCard(number, { model: 'opus' });
      expect(w.sent('card.run')[1].session).not.toHaveProperty('fresh');
    });

    it('degrades to resuming on a runner without cardFreshStart', async () => {
      await advertise({ cardFreshStart: false });
      const { number } = await classified('mechanical');
      await w.runCard(number);
      await stop(number);
      await w.runCard(number, { model: 'opus' });
      expect(w.sent('card.run')[1].session).not.toHaveProperty('fresh');
    });
  });

  describe('the escalation (D8–D10)', () => {
    it('offers escalate_card to a sonnet round of the B arm only', async () => {
      await advertise();
      await w.modelByType('on');
      const { number } = await classified('mechanical');
      await w.runCard(number);
      expect(w.sent('card.run')[0]).toMatchObject({ escalate: true });

      await advertise({ cardEscalate: false });
      await stop(number);
      await w.runCard(number);
      expect(w.sent('card.run')[1]).not.toHaveProperty('escalate');
    });

    it('ends the round and relaunches once on opus at high, in a fresh session carrying the note', async () => {
      await advertise();
      await w.modelByType('on');
      const { number } = await classified('mechanical');
      await w.runCard(number);

      expect(await escalate(number)).toEqual({ number, relaunched: true });
      await roundCount(number, 2);
      await w.work.settled();
      const card = await w.card(number);
      expect(card.rounds[0]).toMatchObject({
        finishedBy: 'worker',
        escalation: 'misclassified',
      });
      expect(card.rounds[1]).toMatchObject({ trigger: 'escalation' });
      expect(card).toMatchObject({
        column: 'in_progress',
        workClass: 'deciding',
        escalationReason: 'misclassified',
        escalationNote: 'The card needs a schema decision.',
        model: null,
      });
      const relaunch = w.sent('card.run')[1];
      expect(relaunch).toMatchObject({
        model: 'opus',
        effort: 'high',
        session: { resume: true, fresh: true },
      });
      expect(relaunch).not.toHaveProperty('escalate');
      expect(String(relaunch.prompt)).toContain(
        'The card needs a schema decision.',
      );
      const [record] = await w.audit('card.escalated');
      expect(record.after).toMatchObject({
        number,
        reason: 'misclassified',
        model: 'sonnet',
        relaunched: true,
      });

      // Once: the opus round, and the card, cannot escalate again.
      await expect(escalate(number)).rejects.toBeInstanceOf(CardNotEscalatable);
      expect((await w.card(number)).rounds).toHaveLength(2);
    });

    it('does not overrule a person’s sonnet: the card waits for Run on Opus (D10)', async () => {
      await advertise();
      await w.modelByType('on');
      const { number } = await classified('deciding', 'low', ['schema']);
      await w.runCard(number, { model: 'sonnet' });
      expect((await w.card(number)).model).toBe('sonnet');

      expect(await escalate(number, 'gave_up')).toEqual({
        number,
        relaunched: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const waiting = await w.card(number);
      expect(waiting.column).toBe('finished');
      expect(waiting.rounds).toHaveLength(1);
      const detail = await w.operator.get(`${w.path()}/board/cards/${number}`);
      expect(detail.body.escalation).toMatchObject({ reason: 'gave_up' });
      expect(detail.body).toMatchObject({
        escalated: true,
        sessionModel: 'sonnet',
        sessionEffort: 'high',
      });

      // Run on Opus is a launch: a viewer is refused, an operator starts it.
      const refused = await w.viewer.send(
        'post',
        `${w.path()}/board/cards/${number}/run`,
        { model: 'opus' },
      );
      expect(refused.status).toBe(403);
      expect((await w.runCard(number, { model: 'opus' })).status).toBe(200);
      expect((await runOf(number, 1)).model).toBe('opus');
    });

    it('refuses an A-arm round, an opus round and a card that is not this session’s', async () => {
      await advertise();
      const a = await classified('mechanical');
      await w.runCard(a.number);
      await expect(escalate(a.number)).rejects.toBeInstanceOf(
        CardNotEscalatable,
      );

      await w.modelByType('on');
      const opus = await classified('deciding');
      await w.runCard(opus.number);
      await expect(escalate(opus.number)).rejects.toBeInstanceOf(
        CardNotEscalatable,
      );

      expect(
        await rounds.escalateByWorker(
          { id: w.b, runnerId: w.runnerId },
          (await w.card(opus.number)).sessionId ?? '',
          'gave_up',
          'Wrong project.',
        ),
      ).toBeNull();
    });

    it('a session that just ends does not escalate', async () => {
      await advertise();
      await w.modelByType('on');
      const { number } = await classified('mechanical');
      await w.runCard(number);
      await stop(number);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const card = await w.card(number);
      expect(card.escalatedAt).toBeNull();
      expect(card.rounds).toHaveLength(1);
      await expect(escalate(number)).rejects.toBeInstanceOf(CardNotEscalatable);
    });
  });
});
