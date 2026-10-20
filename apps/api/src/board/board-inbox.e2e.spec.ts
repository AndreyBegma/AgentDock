import type { BoardCardDetail, BoardView } from '@nautelle/shared';
import { captureFingerprint } from '@nautelle/shared';
import { CaptureWorld } from '../capture/testing/capture-e2e';

describe('board Inbox (e2e)', () => {
  const w = new CaptureWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const detail = async (number: number): Promise<BoardCardDetail> => {
    const response = await w.operator.get(`${w.path()}/board/cards/${number}`);
    expect(response.status).toBe(200);
    return response.body as BoardCardDetail;
  };

  it('puts suggestions in the Inbox with why, confidence and evidence', async () => {
    const { sessionId, captureId, contentId } = await w.suggest([
      { title: 'Fix the redirect loop', confidence: 0.8 },
      { title: 'Keep the timezone on save', kind: 'feature' },
    ]);
    const board = (await w.operator.get(`${w.path()}/board`)).body as BoardView;
    expect(board.columns[0].column).toBe('inbox');
    expect(board.columns[0].cards.map((c) => c.title)).toEqual([
      'Fix the redirect loop',
      'Keep the timezone on save',
    ]);
    expect(board.columns[0].cards[0]).toMatchObject({
      source: 'captured',
      captureWhy: 'The developer said to do it later.',
      captureConfidence: 0.8,
      sourceSessionId: sessionId,
    });
    const card = await detail(board.columns[0].cards[0].number);
    expect(card.evidence).toEqual([
      {
        contentId,
        kind: 'prompt',
        excerpt: expect.stringContaining('The login page loops'),
      },
    ]);
    const [capture] = await w.captures(sessionId);
    expect(capture).toMatchObject({
      id: captureId,
      status: 'succeeded',
      suggested: 2,
    });
    expect(await w.audit('card.captured')).toHaveLength(2);
    const [audit] = await w.audit('card.captured');
    expect(audit.meta).toMatchObject({ captureId });
  });

  it('Accept moves the card to the top of To Do and strips its evidence', async () => {
    await w.createCard({ title: 'Existing work' });
    await w.suggest([{ title: 'Fix the redirect loop' }]);
    const [suggested] = await w.inbox();

    const response = await w.operator.send(
      'post',
      `${w.path()}/board/cards/${suggested.number}/accept-suggestion`,
      {},
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      column: 'todo',
      source: 'captured',
      evidence: null,
      sourceSessionId: suggested.sourceSessionId,
    });
    const board = (await w.operator.get(`${w.path()}/board`)).body as BoardView;
    const todo = board.columns.find((c) => c.column === 'todo');
    expect(todo?.cards.map((c) => c.title)).toEqual([
      'Fix the redirect loop',
      'Existing work',
    ]);
    expect(await w.inbox()).toEqual([]);
    const [audit] = await w.audit('card.inbox_accepted');
    expect(audit.after).toMatchObject({ number: suggested.number });
  });

  it('Edit & accept changes the card on the way, and its fingerprint', async () => {
    await w.suggest([{ title: 'Fix the redirect loop' }]);
    const [suggested] = await w.inbox();
    const response = await w.operator.send(
      'post',
      `${w.path()}/board/cards/${suggested.number}/accept-suggestion`,
      { title: 'Fix the OAuth redirect loop', body: 'Steps…', kind: 'bug' },
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      column: 'todo',
      title: 'Fix the OAuth redirect loop',
      body: 'Steps…',
      kind: 'bug',
    });
    const card = await w.card(suggested.number);
    expect(card.fingerprint).toBe(
      captureFingerprint('Fix the OAuth redirect loop'),
    );
    const [audit] = await w.audit('card.inbox_accepted');
    expect(audit.after).toMatchObject({ title: 'Fix the OAuth redirect loop' });
  });

  it('Dismiss deletes the card and records a dismissal that blocks it again', async () => {
    await w.suggest([{ title: 'Fix the redirect loop' }]);
    const [suggested] = await w.inbox();
    const response = await w.operator.send(
      'post',
      `${w.path()}/board/cards/${suggested.number}/dismiss`,
    );
    expect(response.status).toBe(204);
    expect(await w.inbox()).toEqual([]);
    const dismissals = await w.ctx.prisma.cardDismissal.findMany();
    expect(dismissals).toEqual([
      expect.objectContaining({
        projectId: w.a,
        fingerprint: captureFingerprint('Fix the redirect loop'),
        title: 'Fix the redirect loop',
        dismissedById: w.operatorId,
      }),
    ]);
    expect(await w.audit('card.dismissed')).toHaveLength(1);

    // The same suggestion again is dropped.
    await w.suggest([{ title: 'fix the redirect-loop' }]);
    expect(await w.inbox()).toEqual([]);
  });

  it('Dismiss all empties the Inbox', async () => {
    await w.suggest([{ title: 'One' }, { title: 'Two' }, { title: 'Three' }]);
    const response = await w.operator.send(
      'post',
      `${w.path()}/board/inbox/dismiss-all`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ dismissed: 3 });
    expect(await w.inbox()).toEqual([]);
    expect(await w.ctx.prisma.cardDismissal.count()).toBe(3);
  });

  it('dragging Inbox → To Do accepts; Inbox → Finished is 409 invalid_move', async () => {
    await w.suggest([{ title: 'Drag me' }, { title: 'Not there' }]);
    const [first, second] = await w.inbox();

    const refused = await w.operator.send(
      'post',
      `${w.path()}/board/cards/${second.number}/move`,
      { column: 'finished', index: 0 },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('invalid_move');

    const dragged = await w.operator.send(
      'post',
      `${w.path()}/board/cards/${first.number}/move`,
      { column: 'todo', index: 0 },
    );
    expect(dragged.status).toBe(200);
    expect(dragged.body).toMatchObject({ column: 'todo', evidence: null });
    expect(await w.audit('card.inbox_accepted')).toHaveLength(1);

    // Nothing enters the Inbox.
    const back = await w.operator.send(
      'post',
      `${w.path()}/board/cards/${first.number}/move`,
      { column: 'inbox', index: 0 },
    );
    expect(back.status).toBe(409);
    expect(back.body.error).toBe('invalid_move');
  });

  it('accept and dismiss want an Inbox card; a suggestion does not run', async () => {
    const { number } = await w.createCard({ title: 'Manual' });
    for (const action of ['accept-suggestion', 'dismiss']) {
      const response = await w.operator.send(
        'post',
        `${w.path()}/board/cards/${number}/${action}`,
        {},
      );
      expect([action, response.status, response.body.error]).toEqual([
        action,
        409,
        'wrong_column',
      ]);
    }
    await w.suggest([{ title: 'Suggested' }]);
    const [suggested] = await w.inbox();
    const run = await w.runCard(suggested.number);
    expect(run.status).toBe(409);
    expect(w.sent('card.run')).toEqual([]);
  });
});
