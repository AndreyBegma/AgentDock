import { captureFingerprint, textNormalizeJobId } from '@nautelle/shared';
import { Logger } from '@nestjs/common';
import {
  DEEPL_FAKE_URL,
  FAKE_DEEPL_KEY,
  FakeDeepL,
  tag,
} from './testing/deepl-e2e';
import { RU_BODY, RU_TITLE, TextWorld } from './testing/text-e2e';

// #324: the app starts with a key, and the fake answers every DeepL call.
process.env.DEEPL_API_KEY = FAKE_DEEPL_KEY;

const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

const EN_TITLE = 'Add login';
const EN_BODY = 'Users sign in with a password.';

describe('DeepL translates saved text at save time (e2e)', () => {
  const w = new TextWorld();
  const deepl = new FakeDeepL();
  /** Everything the process printed — Nest's logger writes here. */
  const output: string[] = [];
  const writes: jest.SpyInstance[] = [];

  beforeAll(async () => {
    for (const level of LEVELS) {
      writes.push(
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            output.push(args.map(String).join(' '));
          }),
      );
    }
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      writes.push(
        jest
          .spyOn(stream, 'write')
          .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
            output.push(String(chunk));
            return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
          }),
      );
    }
    deepl.install();
    await w.init();
  });
  afterAll(async () => {
    await w.close();
    deepl.uninstall();
    for (const spy of writes) spy.mockRestore();
  });
  beforeEach(async () => {
    deepl.reset();
    deepl.dictionary.set(RU_TITLE, EN_TITLE);
    deepl.dictionary.set(RU_BODY, EN_BODY);
    await w.reset();
  });
  afterEach(() => w.work.settled());

  const textRuns = () =>
    w.ctx.prisma.run.count({ where: { kind: 'text_normalize' } });

  it('a Russian card answers its POST in English; the row records DeepL; no run is made', async () => {
    const created = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: RU_TITLE,
      body: RU_BODY,
      kind: 'feature',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: EN_TITLE, body: EN_BODY });

    expect(deepl.calls).toHaveLength(1);
    expect(deepl.calls[0]).toMatchObject({
      texts: [RU_TITLE, RU_BODY],
      authorization: `DeepL-Auth-Key ${FAKE_DEEPL_KEY}`,
      body: {
        target_lang: 'EN-US',
        tag_handling: 'xml',
        ignore_tags: ['x'],
        preserve_formatting: true,
        outline_detection: false,
        split_sentences: 'nonewlines',
      },
    });

    const row = await w.latest();
    expect(row).toMatchObject({
      engine: 'deepl',
      status: 'done',
      billedChars: EN_TITLE.length + EN_BODY.length,
      runId: null,
    });
    expect(w.fields(row)).toMatchObject([
      {
        field: 'title',
        original: RU_TITLE,
        outcome: 'translated',
        english: EN_TITLE,
      },
      {
        field: 'body',
        original: RU_BODY,
        outcome: 'translated',
        english: EN_BODY,
      },
    ]);
    expect(await textRuns()).toBe(0);
    expect(w.normalized()).toHaveLength(0);
    expect(
      await w.textQueue.getJob(textNormalizeJobId(row.id)),
    ).toBeUndefined();

    const card = await w.card(created.body.number as number);
    expect(card.fingerprint).toBe(captureFingerprint(EN_TITLE));
    const views = await w.views(`cardId=${card.id}`);
    expect(views.get('board_card:title')).toMatchObject({
      status: 'normalized',
      original: RU_TITLE,
    });
  });

  it('an edit answers its PATCH in English', async () => {
    const { number } = await w.createCard({
      title: 'Add login',
      kind: 'feature',
    });
    deepl.dictionary.set('Новое описание', 'A new description');
    const patched = await w.operator.send(
      'patch',
      `${w.path()}/board/cards/${number}`,
      { body: 'Новое описание' },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.body).toBe('A new description');
  });

  it('code, a path, a URL and #123 come back byte-identical', async () => {
    const body =
      'Почини `src/run.ts` в #123, см. https://example.com/a?b=1&c=2.\n\n```ts\nconst ok = a < b && c > d;\n```\n- пункт';
    deepl.dictionary.set('Почини', 'Fix');
    deepl.dictionary.set(' в ', ' in ');
    deepl.dictionary.set('см.', 'see');
    deepl.dictionary.set('пункт', 'item');
    const created = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: RU_TITLE,
      body,
      kind: 'feature',
    });
    expect(created.status).toBe(201);
    // Spans travel as tags, and only the prose is DeepL's to see.
    expect(deepl.calls[0].texts[1]).toBe(
      `Почини ${tag(1)} в ${tag(2)}, см. ${tag(3)}.\n\n${tag(4)}\n- пункт`,
    );
    expect(created.body.body).toBe(
      'Fix `src/run.ts` in #123, see https://example.com/a?b=1&c=2.\n\n```ts\nconst ok = a < b && c > d;\n```\n- item',
    );
  });

  it('an answer that drops a tag leaves that field as typed, rejected; the other field translates', async () => {
    const body = 'Смотри `foo()` тут';
    deepl.reply = (texts) => [
      { text: deepl.translate(texts[0]) },
      { text: 'Look here' },
    ];
    const created = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: RU_TITLE,
      body,
      kind: 'feature',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: EN_TITLE, body });
    const row = await w.latest();
    expect(row).toMatchObject({ status: 'done', engine: 'deepl' });
    expect(w.fields(row).map((f) => [f.field, f.outcome])).toEqual([
      ['title', 'translated'],
      ['body', 'rejected'],
    ]);
    const views = await w.views(`cardId=${created.body.id as string}`);
    expect(views.get('board_card:body')).toMatchObject({
      status: 'not_normalized',
      reason: 'rejected',
    });
  });

  it('a timeout answers the save in about 4 s, as typed; the job applies DeepL later', async () => {
    deepl.reply = () => 'hang';
    const started = Date.now();
    const created = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: RU_TITLE,
      body: RU_BODY,
      kind: 'feature',
    });
    const took = Date.now() - started;
    expect(created.status).toBe(201);
    expect(took).toBeGreaterThanOrEqual(3900);
    expect(took).toBeLessThan(4500);
    expect(created.body).toMatchObject({ title: RU_TITLE, body: RU_BODY });

    const row = await w.latest();
    expect(row).toMatchObject({
      status: 'pending',
      engine: null,
      error: 'deepl: no answer in time',
    });
    const job = await w.textQueue.getJob(textNormalizeJobId(row.id));
    expect(job?.data).toEqual({ normalizationId: row.id });

    deepl.reset();
    deepl.dictionary.set(RU_TITLE, EN_TITLE);
    deepl.dictionary.set(RU_BODY, EN_BODY);
    expect(await w.process(row.id, job?.data)).toEqual({ kind: 'translated' });
    const card = await w.card(created.body.number as number);
    expect(card).toMatchObject({ title: EN_TITLE, body: EN_BODY });
    expect(await w.latest()).toMatchObject({ status: 'done', engine: 'deepl' });
    expect(await textRuns()).toBe(0);
  });

  it('the job retries DeepL on a 5xx, then hands the request to the runner', async () => {
    deepl.reply = () => ({ status: 503 });
    const { number } = await w.createCard({
      title: RU_TITLE,
      body: RU_BODY,
      kind: 'feature',
    });
    const row = await w.latest();
    const first = await w.process(row.id);
    expect(first).toMatchObject({
      kind: 'deferred',
      why: 'deepl_retry',
      data: { deeplAttempts: 1 },
    });
    const second = await w.process(row.id, { deeplAttempts: 1 });
    if (second.kind !== 'started') throw new Error(JSON.stringify(second));
    const { runId } = second;
    // The save's attempt and two in the job (`TEXT_RUN_RETRIES`), then the runner.
    expect(deepl.calls).toHaveLength(3);
    expect(w.normalized()).toHaveLength(1);
    expect(await w.latest()).toMatchObject({
      status: 'running',
      runId,
      engine: 'runner',
    });
    expect((await w.card(number)).title).toBe(RU_TITLE);
  });

  it('a 456 sends the job straight to the runner; with no runner online the field ends Not normalized', async () => {
    deepl.reply = () => ({ status: 456 });
    const created = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: RU_TITLE,
      body: RU_BODY,
      kind: 'feature',
    });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe(RU_TITLE);
    const row = await w.latest();
    expect(row).toMatchObject({ status: 'pending', error: 'deepl: HTTP 456' });
    const job = await w.textQueue.getJob(textNormalizeJobId(row.id));
    expect(job?.data).toEqual({ normalizationId: row.id, runnerOnly: true });

    w.runnerState = 'offline';
    const deferred = await w.process(row.id, job?.data);
    // The worker merges `data` into the job's, which keeps `runnerOnly`.
    expect(deferred).toMatchObject({
      kind: 'deferred',
      why: 'runner_offline',
      data: { offlineAttempts: 1 },
    });
    // No second DeepL call: the quota is spent.
    expect(deepl.calls).toHaveLength(1);
    const gaveUp = await w.process(row.id, {
      runnerOnly: true,
      offlineSince: Date.now() - 25 * 60 * 60 * 1000,
    });
    expect(gaveUp).toEqual({ kind: 'failed', reason: 'runner_offline' });
    const views = await w.views(`cardId=${created.body.id as string}`);
    expect(views.get('board_card:title')).toMatchObject({
      status: 'not_normalized',
      reason: 'runner_offline',
    });
    expect(deepl.calls).toHaveLength(1);
  });

  it('a 403 with a runner online runs text.normalize', async () => {
    deepl.reply = () => ({ status: 403 });
    await w.createCard({ title: RU_TITLE, body: RU_BODY, kind: 'feature' });
    const row = await w.latest();
    const job = await w.textQueue.getJob(textNormalizeJobId(row.id));
    expect(job?.data.runnerOnly).toBe(true);
    const outcome = await w.process(row.id, job?.data);
    expect(outcome.kind).toBe('started');
    expect(w.normalized()[0].prompt).toContain(RU_TITLE);
    expect(await w.latest()).toMatchObject({
      engine: 'runner',
      status: 'running',
    });
  });

  it('English input makes no DeepL call; DeepL detecting English leaves the column untouched', async () => {
    const english = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: 'Add a dark mode to the settings page',
      body: 'The users want it for the evening.',
      kind: 'feature',
    });
    expect(english.status).toBe(201);
    expect(deepl.calls).toHaveLength(0);

    // Latin script with no English function words reaches DeepL.
    const latin = 'Hola amigos como estan todos hoy';
    deepl.reply = (texts) =>
      texts.map(() => ({ text: 'Hello friends', lang: 'EN' }));
    const created = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: latin,
      kind: 'feature',
    });
    expect(deepl.calls).toHaveLength(1);
    expect(created.body.title).toBe(latin);
    const row = await w.latest();
    expect(row).toMatchObject({ status: 'done', engine: 'deepl' });
    expect(w.fields(row)).toMatchObject([
      { field: 'title', original: latin, outcome: 'already_english' },
    ]);
  });

  it('kind: an auto card "Кнопка Run падает с ошибкой" becomes a bug; a person\'s kind stays', async () => {
    const title = 'Кнопка Run падает с ошибкой';
    deepl.dictionary.set(title, 'The Run button crashes with an error');
    const auto = await w.operator.send('post', `${w.path()}/board/cards`, {
      title,
    });
    expect(auto.status).toBe(201);
    expect(auto.body).toMatchObject({
      title: 'The Run button crashes with an error',
      kind: 'bug',
      kindSource: 'auto',
    });
    expect(await w.latest()).toMatchObject({ classifyKind: true, kind: 'bug' });

    const person = await w.operator.send('post', `${w.path()}/board/cards`, {
      title,
      kind: 'feature',
    });
    expect(person.body).toMatchObject({
      kind: 'feature',
      kindSource: 'person',
    });

    // English and auto: no call, and the rule still sets the kind.
    const english = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: 'Fix the broken export',
    });
    expect(english.body).toMatchObject({ kind: 'bug', kindSource: 'auto' });
    expect(deepl.calls).toHaveLength(2);
    expect(await w.latest()).toMatchObject({ status: 'done', engine: null });
    expect(await textRuns()).toBe(0);
  });

  it('a project with normalization off makes no DeepL call', async () => {
    await w.ctx.prisma.textSettings.create({
      data: { projectId: w.a, normalizeEnabled: false },
    });
    const created = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: RU_TITLE,
      body: RU_BODY,
    });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe(RU_TITLE);
    expect(deepl.calls).toHaveLength(0);
    expect(await w.requests()).toHaveLength(0);
  });

  it('DEEPL_API_KEY appears in no log line, no response, no runner command and no audit row', async () => {
    deepl.reply = () => ({ status: 456 });
    const created = await w.operator.send('post', `${w.path()}/board/cards`, {
      title: RU_TITLE,
      body: RU_BODY,
    });
    const row = await w.latest();
    await w.process(row.id, { runnerOnly: true });
    const views = await w.operator.get(
      `${w.path()}/text-normalizations?cardId=${created.body.id as string}`,
    );
    const audit = await w.ctx.prisma.auditRecord.findMany({});
    const seen = [
      JSON.stringify(created.body),
      JSON.stringify(views.body),
      JSON.stringify(w.normalized()),
      JSON.stringify(audit, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
      JSON.stringify(await w.requests()),
      output.join(''),
    ];
    expect(output.join('')).toContain('deepl: HTTP 456');
    for (const text of seen) {
      expect(text).not.toContain(FAKE_DEEPL_KEY);
      expect(text).not.toContain('e2e-fake-deepl-key');
    }
    // It travelled once per call, in the header to DeepL only.
    expect(deepl.calls.map((c) => c.authorization)).toEqual([
      `DeepL-Auth-Key ${FAKE_DEEPL_KEY}`,
    ]);
    expect(DEEPL_FAKE_URL).toContain('api-free');
  });
});
