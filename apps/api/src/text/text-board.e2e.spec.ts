import { captureFingerprint } from '@nautelle/shared';
import { RU_BODY, RU_TITLE, TextWorld, textBlock } from './testing/text-e2e';

describe('text normalization of board cards (e2e)', () => {
  const w = new TextWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  it('a Russian card is created at once as typed; the result makes it English, refingerprints it and sets kind', async () => {
    const created = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: RU_TITLE,
      body: RU_BODY,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: RU_TITLE,
      kind: 'feature',
      kindSource: 'auto',
    });
    const cardId = created.body.id as string;

    let views = await w.views(`cardId=${cardId}`);
    expect(views.get('board_card:title')).toMatchObject({
      ownerId: cardId,
      status: 'normalizing',
    });
    expect(views.get('board_card:body')?.status).toBe('normalizing');

    const row = await w.latest();
    expect(row).toMatchObject({
      ownerType: 'board_card',
      cardId,
      status: 'pending',
      classifyKind: true,
    });
    const runId = await w.start(row.id);
    const [sent] = w.normalized();
    expect(sent).toMatchObject({ runId, model: 'haiku', timeoutSec: 120 });
    expect(sent.prompt).toContain(RU_TITLE);
    expect(sent.prompt).toContain('"kind"');

    await w.finish(
      runId,
      textBlock(
        [
          { id: 'title', english: 'Add login' },
          { id: 'body', english: 'Users sign in with a password.' },
        ],
        'bug',
      ),
    );

    const card = await w.card(created.body.number as number);
    expect(card).toMatchObject({
      title: 'Add login',
      body: 'Users sign in with a password.',
      fingerprint: captureFingerprint('Add login'),
      kind: 'bug',
      kindSource: 'auto',
    });
    expect(await w.latest()).toMatchObject({ status: 'done', kind: 'bug' });

    views = await w.views(`cardId=${cardId}`);
    expect(views.get('board_card:title')).toMatchObject({
      status: 'normalized',
      original: RU_TITLE,
    });
    expect(views.get('board_card:body')).toMatchObject({
      status: 'normalized',
      original: RU_BODY,
    });
    // A viewer reads the originals too (D14).
    const asViewer = await w.views(`cardId=${cardId}`, w.viewer);
    expect(asViewer.get('board_card:title')?.original).toBe(RU_TITLE);
  });

  it('an edit while normalizing wins: the stale field is superseded, the rest applies (D8)', async () => {
    const { id: cardId, number } = await w.createCard({
      title: RU_TITLE,
      body: RU_BODY,
      kind: 'feature',
    });
    const first = await w.latest();
    const runId = await w.start(first.id);

    const edited = 'Добавить вход через SSO';
    const patch = await w.operator.send(
      'patch',
      `${w.path()}/board/cards/${number}`,
      { title: edited },
    );
    expect(patch.status).toBe(200);

    await w.finish(
      runId,
      textBlock([
        { id: 'title', english: 'Add login' },
        { id: 'body', english: 'Users sign in with a password.' },
      ]),
    );
    const card = await w.card(number);
    expect(card.title).toBe(edited);
    expect(card.body).toBe('Users sign in with a password.');
    expect(card.fingerprint).toBe(captureFingerprint(edited));

    const rows = await w.requests();
    expect(rows).toHaveLength(2);
    expect(w.fields(rows[0]).map((f) => [f.field, f.outcome])).toEqual([
      ['title', 'superseded'],
      ['body', 'translated'],
    ]);
    // The edit made its own request, for the title only.
    expect(rows[1]).toMatchObject({ cardId, status: 'pending' });
    expect(w.fields(rows[1]).map((f) => f.field)).toEqual(['title']);
    const views = await w.views(`cardId=${cardId}`);
    expect(views.get('board_card:title')?.status).toBe('normalizing');
    expect(views.get('board_card:body')?.status).toBe('normalized');
  });

  it('a newer save takes over a pending request, keeping its other fields (D8)', async () => {
    const { number } = await w.createCard({
      title: RU_TITLE,
      body: RU_BODY,
      kind: 'bug',
    });
    await w.operator.send('patch', `${w.path()}/board/cards/${number}`, {
      body: 'Пользователи входят по ключу.',
    });
    const [first, second] = await w.requests();
    expect(first.status).toBe('superseded');
    expect(second.status).toBe('pending');
    expect(w.fields(second).map((f) => [f.field, f.original])).toEqual([
      ['body', 'Пользователи входят по ключу.'],
      ['title', RU_TITLE],
    ]);
    // The superseded one never runs.
    expect(await w.process(first.id)).toMatchObject({ kind: 'none' });
    expect(w.normalized()).toHaveLength(0);
  });

  it('never overwrites a kind the person set, nor kind after the first Run (D9)', async () => {
    // Given in the dialog: the person's from the start, and not asked.
    const given = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: RU_TITLE,
      kind: 'feature',
    });
    expect(given.body.kindSource).toBe('person');
    expect((await w.latest()).classifyKind).toBe(false);

    // Auto, then set in the sheet while the request runs.
    const { number: sheet } = await w.createCard({ title: RU_TITLE });
    const sheetRow = await w.latest();
    const sheetRun = await w.start(sheetRow.id);
    await w.operator.send('patch', `${w.path()}/board/cards/${sheet}`, {
      kind: 'feature',
    });
    await w.finish(
      sheetRun,
      // The default body is English: skipped, never asked.
      textBlock([{ id: 'title', english: 'Add login' }], 'bug'),
    );
    expect(await w.card(sheet)).toMatchObject({
      title: 'Add login',
      kind: 'feature',
      kindSource: 'person',
    });

    // Auto, but a Run fixed the branch before the result came.
    const { number: ran } = await w.createCard({ title: RU_TITLE });
    const ranRow = await w.latest();
    const ranRun = await w.start(ranRow.id);
    await w.ctx.prisma.boardCard.update({
      where: { id: ranRow.cardId as string },
      data: { branch: 'feature/c-3-add-login' },
    });
    await w.finish(
      ranRun,
      textBlock([{ id: 'title', english: 'Add login' }], 'bug'),
    );
    expect(await w.card(ran)).toMatchObject({
      title: 'Add login',
      kind: 'feature',
      kindSource: 'auto',
    });
  });

  it('a card created without kind — what the New card dialog sends — is auto (D9)', async () => {
    const { number } = await w.createCard({ title: 'Add login', body: '' });
    expect(await w.card(number)).toMatchObject({
      kind: 'feature',
      kindSource: 'auto',
    });
    // English, but the kind is still the model's: one call, for kind only.
    const row = await w.latest();
    expect(row).toMatchObject({ status: 'pending', classifyKind: true });
    expect(w.fields(row)).toEqual([
      expect.objectContaining({ field: 'title', outcome: 'already_english' }),
    ]);
    const runId = await w.start(row.id);
    await w.finish(runId, textBlock([], 'bug'));
    expect(await w.card(number)).toMatchObject({
      title: 'Add login',
      kind: 'bug',
    });
    const views = await w.views(`cardId=${row.cardId}`);
    expect(views.get('board_card:title')?.status).toBe('english');
  });

  it.each([
    ['Settings page for webhooks', 'page'],
    ['Date range picker component', 'component'],
    ['Three-step onboarding wizard', 'flow'],
  ])('classifies the design template of "%s" as %s with the kind (#833 D8)', async (title, template) => {
    const { number } = await w.createCard({ title, body: '' });
    expect(await w.card(number)).toMatchObject({
      designTemplate: null,
      designTemplateSource: 'auto',
    });
    const row = await w.latest();
    const runId = await w.start(row.id);
    expect(w.normalized()[0].prompt).toContain('"page", "component", "flow"');
    // Answers the fields the request asked, whichever the heuristic skipped.
    const asked = w
      .fields(row)
      .filter((f) => f.outcome === undefined)
      .map((f) => ({ id: f.field, alreadyEnglish: true }));
    await w.finish(runId, textBlock(asked, 'feature', template));
    expect(await w.card(number)).toMatchObject({
      designTemplate: template,
      designTemplateSource: 'auto',
    });
  });

  it('ignores a template key the project does not have (#833 D8)', async () => {
    const { number } = await w.createCard({ title: 'Add login', body: '' });
    const runId = await w.start((await w.latest()).id);
    await w.finish(runId, textBlock([], 'feature', 'landing'));
    expect(await w.card(number)).toMatchObject({ designTemplate: null });
  });

  it("never overwrites the person's template, and a custom template is selectable (#833 D8)", async () => {
    const { number } = await w.createCard({ title: 'Add login', body: '' });
    const runId = await w.start((await w.latest()).id);
    await w.ctx.prisma.designTemplate.create({
      data: {
        projectId: w.a,
        key: 'landing',
        name: 'Landing',
        definition: {
          frames: [
            {
              key: 'hero',
              kind: 'custom',
              name: 'Hero',
              instruction: 'Draw the hero.',
              required: true,
              enabled: true,
            },
          ],
        },
      },
    });
    const patched = await w.operator.send(
      'patch',
      `${w.path()}/board/cards/${number}`,
      { designTemplate: 'landing' },
    );
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      designTemplate: 'landing',
      designTemplateSource: 'person',
    });
    // The request that was running answers after the person chose.
    await w.finish(runId, textBlock([], 'feature', 'flow'));
    expect(await w.card(number)).toMatchObject({
      designTemplate: 'landing',
      designTemplateSource: 'person',
    });

    const unknown = await w.operator.send(
      'patch',
      `${w.path()}/board/cards/${number}`,
      { designTemplate: 'email' },
    );
    expect(unknown.status).toBe(400);
  });

  it('accepting a suggestion normalizes its text and keeps its extracted kind', async () => {
    // A suggestion as capture leaves it: model-written, auto kind.
    const { id, number } = await w.createCard({ title: 'Seed', body: '' });
    await w.ctx.prisma.textNormalization.deleteMany({});
    await w.ctx.prisma.boardCard.update({
      where: { id },
      data: {
        title: RU_TITLE,
        kind: 'bug',
        column: 'inbox',
        source: 'captured',
      },
    });
    const accepted = await w.operator.send(
      'post',
      `${w.path()}/board/cards/${number}/accept-suggestion`,
      {},
    );
    expect(accepted.status).toBe(200);
    const row = await w.latest();
    expect(row).toMatchObject({ cardId: id, classifyKind: false });
    const runId = await w.start(row.id);
    await w.finish(runId, textBlock([{ id: 'title', english: 'Add login' }]));
    expect(await w.card(number)).toMatchObject({
      title: 'Add login',
      kind: 'bug',
      column: 'todo',
    });
  });
});
