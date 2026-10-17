import type { BoardCardDetail, PendingQuestion } from '@agentdock/shared';
import type { SessionMessageArgs } from '@agentdock/shared/protocol';
import { BoardWorld, ROOT_A } from '../board/testing/board-e2e';
import {
  type CommandSendResult,
  RunnerCommandService,
} from '../runners/runner-command.service';
import { SessionMessageService } from './session-message.service';

const ESC = '\u001b';

/** A row as text, `seq` (a bigint) included. */
const asText = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );

const QUESTION: PendingQuestion = {
  key: '0123456789abcdef',
  header: 'glass-ui',
  text: 'SelectionBar is missing in glass-ui — what now?',
  options: [
    { index: 1, label: 'Add it to glass-ui' },
    { index: 2, label: 'Use a Toolbar' },
  ],
  other: true,
};

describe('session messages (#489, e2e)', () => {
  const w = new BoardWorld();
  let commands: RunnerCommandService;
  let served = true;
  let answer: CommandSendResult<'session.message'> = {
    status: 'ok',
    output: { outcome: 'sent' },
    rttMs: 1,
  };

  beforeAll(async () => {
    await w.init();
    commands = w.ctx.app.get(RunnerCommandService);
    const original = commands.send.bind(commands);
    jest
      .spyOn(commands, 'send')
      .mockImplementation(async (runnerId, name, args, options) =>
        name === 'session.message'
          ? (answer as never)
          : original(runnerId, name, args, options),
      );
    jest
      .spyOn(w.ctx.app.get(SessionMessageService), 'available')
      .mockImplementation(async () => served);
  });
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    jest.mocked(commands.send).mockClear();
    served = true;
    answer = { status: 'ok', output: { outcome: 'sent' }, rttMs: 1 };
  });
  afterEach(() => w.work.settled());

  const messagesSent = () =>
    jest
      .mocked(commands.send)
      .mock.calls.filter(([, name]) => name === 'session.message')
      .map(([, , args]) => args as SessionMessageArgs);

  const messagePath = (number = 1) =>
    `${w.path()}/board/cards/${number}/message`;

  const running = async () => {
    await w.createCard();
    expect((await w.runCard(1)).status).toBe(200);
    const card = await w.card(1);
    const round = card.rounds[0];
    if (!round) throw new Error('no round');
    return { cardId: card.id, runId: round.runId };
  };

  describe('a card round', () => {
    it('M1–M3: an operator sends text to the running round — cleaned, sent, audited without the text', async () => {
      const { cardId, runId } = await running();
      const response = await w.operator.send('post', messagePath(), {
        kind: 'text',
        text: `  Also update ${ESC}[31mthe changelog${ESC}[0m\nplease\u0007 `,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ outcome: 'sent' });
      expect(messagesSent()).toEqual([
        {
          projectId: w.a,
          target: { kind: 'card_round', cardId, runId },
          message: {
            kind: 'text',
            text: 'Also update the changelog please',
          },
        },
      ]);
      const [record] = await w.audit('card.message');
      expect(record).toMatchObject({
        projectId: w.a,
        result: 'ok',
        targetType: 'board_card',
        targetId: cardId,
      });
      expect(record?.after).toMatchObject({
        target: { kind: 'card_round', cardId, runId },
        kind: 'text',
        textChars: 'Also update the changelog please'.length,
        textSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        via: 'web',
        outcome: 'sent',
      });
      expect(asText(record)).not.toContain('changelog');
      // The runner.command record gets the hash too, never the text.
      const [[, , , options]] = jest
        .mocked(commands.send)
        .mock.calls.filter(([, name]) => name === 'session.message');
      expect(options.auditArgs).toMatchObject({
        message: { kind: 'text', textSha256: expect.any(String) },
      });
      expect(asText(options.auditArgs)).not.toContain('changelog');
    });

    it('M1: a viewer gets 403 and another project 404; nothing is sent', async () => {
      await running();
      const body = { kind: 'text', text: 'hi' };
      expect((await w.viewer.send('post', messagePath(), body)).status).toBe(
        403,
      );
      expect(
        (await w.operatorOfB.send('post', messagePath(), body)).status,
      ).toBe(404);
      expect(messagesSent()).toEqual([]);
    });

    it('refuses text with nothing left once cleaned, audited; a card with no running round is 409', async () => {
      await running();
      const blank = await w.operator.send('post', messagePath(), {
        kind: 'text',
        text: `${ESC}[A${ESC}[B\u0003`,
      });
      expect(blank.status).toBe(400);
      expect(blank.body).toMatchObject({ error: 'invalid_message' });
      const [record] = await w.audit('card.message');
      expect(record).toMatchObject({ result: 'error' });

      await w.createCard({ title: 'Idle card' });
      const idle = await w.operator.send('post', messagePath(2), {
        kind: 'text',
        text: 'hi',
      });
      expect(idle.status).toBe(409);
      expect(idle.body).toMatchObject({ error: 'not_running' });
      expect(messagesSent()).toEqual([]);
    });

    it('503 when the runner does not take session messages; nothing is sent', async () => {
      await running();
      served = false;
      const response = await w.operator.send('post', messagePath(), {
        kind: 'text',
        text: 'hi',
      });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ error: 'command_unavailable' });
      expect(messagesSent()).toEqual([]);
    });

    it("M4: the round's question screen is on the card while it is up, and an option answers it", async () => {
      const { cardId, runId } = await running();
      const screen = (question: PendingQuestion | null) =>
        w.deliver('card_run.pending_question', {
          cardId,
          runId,
          projectId: w.a,
          at: '2026-10-16T12:00:00.000Z',
          question,
        });
      const detail = async () =>
        (await w.viewer.get(`${w.path()}/board/cards/1`))
          .body as BoardCardDetail;

      await screen(QUESTION);
      expect((await detail()).round?.pendingQuestion).toEqual(QUESTION);

      answer = { status: 'ok', output: { outcome: 'answered' }, rttMs: 1 };
      const response = await w.operator.send('post', messagePath(), {
        kind: 'option',
        questionKey: QUESTION.key,
        index: 2,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ outcome: 'answered' });
      expect(messagesSent()[0]?.message).toEqual({
        kind: 'option',
        questionKey: QUESTION.key,
        index: 2,
      });
      const other = await w.operator.send('post', messagePath(), {
        kind: 'other',
        questionKey: QUESTION.key,
        text: 'Use a Popover',
      });
      expect(other.status).toBe(200);
      expect(messagesSent()[1]?.message).toEqual({
        kind: 'other',
        questionKey: QUESTION.key,
        text: 'Use a Popover',
      });
      const records = await w.audit('card.message');
      expect(records.map((r) => (r.after as { kind: string }).kind)).toEqual([
        'option',
        'other',
      ]);

      await screen(null);
      expect((await detail()).round?.pendingQuestion).toBeNull();
    });

    it('a question screen of a round that is no longer current is not kept', async () => {
      const { cardId } = await running();
      await w.deliver('card_run.pending_question', {
        cardId,
        runId: 'cm1run00000000000000000099',
        projectId: w.a,
        at: '2026-10-16T12:00:00.000Z',
        question: QUESTION,
      });
      const [round] = (await w.card(1)).rounds;
      expect(round?.pendingQuestion).toBeNull();
    });
  });

  describe('a fleet slot (M5)', () => {
    const slotPath = (slot: string) =>
      `${w.path()}/slots/${slot}/session-message`;

    it("an operator's message goes to the slot of the project's root, audited", async () => {
      const response = await w.operator.send('post', slotPath('i42-api'), {
        kind: 'text',
        text: 'Rebase on develop first',
      });
      expect(response.status).toBe(200);
      expect(messagesSent()).toEqual([
        {
          projectId: w.a,
          target: { kind: 'fleet_slot', root: ROOT_A, slot: 'i42-api' },
          message: { kind: 'text', text: 'Rebase on develop first' },
        },
      ]);
      const [record] = await w.audit('slot.session_message');
      expect(record).toMatchObject({
        result: 'ok',
        targetType: 'slot',
        targetId: 'i42-api',
      });
      expect(asText(record)).not.toContain('Rebase');
    });

    it('a viewer gets 403; a slot name that is not one is 400', async () => {
      const body = { kind: 'text', text: 'hi' };
      expect((await w.viewer.send('post', slotPath('i42'), body)).status).toBe(
        403,
      );
      expect(
        (await w.operator.send('post', slotPath('..%2Fx'), body)).status,
      ).toBe(400);
      expect(messagesSent()).toEqual([]);
    });
  });
});
