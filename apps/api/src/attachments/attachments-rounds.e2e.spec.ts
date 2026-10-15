import { createHash } from 'node:crypto';
import {
  attachmentWorktreePath,
  type BoardCardDetail,
  CARD_WORKER_PROMPT_VERSION,
} from '@agentdock/shared';
import { BoardWorld } from '../board/testing/board-e2e';
import {
  FILES,
  uploaded,
  useTempAttachmentsDir,
} from './testing/attachments-e2e';

useTempAttachmentsDir();

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

describe('attachments delivered to the card worker (e2e, #309 D9, D10)', () => {
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
  const promptOf = (index: number) => String(w.sent('card.run')[index].prompt);

  it('card.run lists the attachments by id, name, type, size and SHA-256; the v4 prompt lists their paths', async () => {
    const shot = await uploaded(w, 'login shot.png', FILES.png);
    const log = await uploaded(w, 'trace.log', FILES.text);
    await w.createCard({ attachmentIds: [shot.id, log.id] });
    expect((await w.runCard(1)).status).toBe(200);

    const [sent] = w.sent('card.run');
    expect(sent.attachments).toEqual([
      {
        id: shot.id,
        name: 'login shot.png',
        mime: 'image/png',
        size: FILES.png.length,
        sha256: sha256(FILES.png),
      },
      {
        id: log.id,
        name: 'trace.log',
        mime: 'text/plain',
        size: FILES.text.length,
        sha256: sha256(FILES.text),
      },
    ]);
    const prompt = promptOf(0);
    expect(prompt).toContain('## Attachments');
    expect(prompt).toContain(attachmentWorktreePath(shot.id, shot.name));
    expect(prompt).toContain(attachmentWorktreePath(log.id, log.name));

    const card = await w.card(1);
    expect(card.rounds[0].cardAttachments).toEqual([
      { id: shot.id, name: shot.name, mime: 'image/png' },
      { id: log.id, name: log.name, mime: 'text/plain' },
    ]);
    const run = await w.ctx.prisma.run.findUniqueOrThrow({
      where: { id: card.rounds[0].runId },
    });
    expect(run.args).toMatchObject({
      promptVersion: CARD_WORKER_PROMPT_VERSION,
    });
    // The audit keeps ids and hashes, never the names.
    const call = jest
      .mocked(w.commands.send)
      .mock.calls.find(([, name]) => name === 'card.run');
    const auditArgs = (call?.[3] as { auditArgs?: object }).auditArgs;
    expect(auditArgs).toMatchObject({
      attachments: [
        { id: shot.id, sha256: sha256(FILES.png) },
        { id: log.id, sha256: sha256(FILES.text) },
      ],
    });
    expect(JSON.stringify(auditArgs)).not.toContain('login shot.png');
  });

  it('a card without attachments sends none', async () => {
    await w.createCard();
    await w.runCard(1);
    expect(w.sent('card.run')[0]).not.toHaveProperty('attachments');
    expect(promptOf(0)).not.toContain('## Attachments');
  });

  it('feedback claims its attachments onto the card and the round; the next prompt says what was added', async () => {
    await w.createCard();
    await w.runCard(1);
    await post(1, 'finish');
    const shot = await uploaded(w, 'bug.png');

    const response = await post(1, 'feedback', {
      text: 'The button is cut off, see the screenshot.',
      attachmentIds: [shot.id],
    });
    expect(response.status).toBe(200);
    const detail = response.body as BoardCardDetail;
    const round2 = detail.rounds.find((r) => r.round === 2);
    expect(detail.attachments).toEqual([
      expect.objectContaining({ id: shot.id, roundId: round2?.id }),
    ]);

    const sent = w.sent('card.run')[1];
    expect(sent.attachments).toEqual([
      expect.objectContaining({ id: shot.id, sha256: sha256(FILES.png) }),
    ]);
    const prompt = promptOf(1);
    expect(prompt).toContain('## Attachments changed');
    expect(prompt).toContain(attachmentWorktreePath(shot.id, shot.name));
    expect(prompt).toContain('The button is cut off');
    const [record] = await w.audit('attachment.claimed');
    expect(record.after).toMatchObject({
      roundId: round2?.id,
      attachmentIds: [shot.id],
    });
  });

  it('a round after an attachment was removed says so; one without changes does not', async () => {
    const shot = await uploaded(w, 'old.png');
    await w.createCard({ attachmentIds: [shot.id] });
    await w.runCard(1);
    await post(1, 'finish');
    await post(1, 'feedback', { text: 'Again.' });
    expect(promptOf(1)).not.toContain('## Attachments changed');

    await post(1, 'finish');
    expect(
      (await w.operator.send('delete', `${w.path()}/attachments/${shot.id}`))
        .status,
    ).toBe(204);
    await post(1, 'feedback', { text: 'Once more.' });
    expect(promptOf(2)).toContain('Removed (no longer there');
    expect(promptOf(2)).toContain('- old.png');
    expect(w.sent('card.run')[2]).not.toHaveProperty('attachments');
  });

  it("refuses feedback with another user's upload before any round exists", async () => {
    await w.createCard();
    await w.runCard(1);
    await post(1, 'finish');
    const admins = await uploaded(w, 'a.png', FILES.png, w.admin);
    const response = await post(1, 'feedback', {
      text: 'x',
      attachmentIds: [admins.id],
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('not_claimable');
    expect((await w.card(1)).rounds).toHaveLength(1);
    expect(w.sent('card.run')).toHaveLength(1);
  });

  it('fails the round with attachments_unavailable when the runner cannot fetch them', async () => {
    const shot = await uploaded(w);
    await w.createCard({ attachmentIds: [shot.id] });
    w.handlers['card.run'] = () => ({
      status: 'error',
      error: { code: 'attachments_unavailable', message: 'sha256 mismatch' },
    });
    const response = await w.runCard(1);
    expect(response.status).toBe(502);
    expect(response.body.error).toBe('attachments_unavailable');
    expect((await w.card(1)).rounds[0].phase).toBe('failed');
  });
});
