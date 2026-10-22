import type { DesignFrameKind } from '@nautelle/shared';
import { PLAN_TURN_RESULT_TOTAL_MAX_BYTES } from '@nautelle/shared/protocol';
import { CardDesignHarness } from './testing/card-design-e2e';
import { designResult, MOCKUP, type TestFrame } from './testing/design-e2e';

/** A card's design turns answer the contract under this key (#243 D2). */
const KEY = 'card-1';

/** A frame of `kind`, named for it. */
const frame = (kind: DesignFrameKind, name: string = kind): TestFrame => ({
  name,
  kind,
  html: MOCKUP.replace('Export', name),
});
const steps = (n: number) =>
  Array.from({ length: n }, (_, i) => frame('flow_step', `Step ${i + 1}`));

/**
 * #833 (ADR-0082): a design follows a frame template — the turn is checked
 * against it, an answer off it gets one repair turn, a revise keeps the
 * required frames it leaves out, and a person can Complete it.
 */
describe('design frame templates (e2e, #833)', () => {
  const h = new CardDesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const base = (number: number) => h.cardDesignBase(number);
  const designTurns = (cardId: string) =>
    h.ctx.prisma.planTurn.findMany({
      where: { cardId, action: 'design' },
      orderBy: { createdAt: 'asc' },
    });
  const revisions = (cardId: string) =>
    h.ctx.prisma.designRevision.findMany({
      where: { design: { cardId } },
      orderBy: [{ variant: 'asc' }, { revision: 'asc' }],
      include: { frames: { orderBy: { position: 'asc' } } },
    });

  /** A card on `template` with `variants` variants, its Generate started. */
  const generated = async (template: string | null, variants = 1) => {
    await h.seedProfile();
    const card = await h.designedCard(variants);
    if (template) {
      await h.ctx.prisma.boardCard.update({
        where: { id: card.id },
        data: { designTemplate: template },
      });
    }
    expect(
      (await h.author.send('post', `${base(card.number)}/generate`)).status,
    ).toBe(201);
    return card;
  };

  it('stores a page answer with its kinds and positions, conforming', async () => {
    const card = await generated(null);
    const prompt = String(h.sentOf('plan.turn').at(-1)?.prompt);
    expect(prompt).toContain('# Frames to draw');
    expect(prompt).toContain('Template: "Page" (`page`)');
    await h.finishCard(
      card.id,
      designResult({ taskKey: KEY, variant: 1 }, [
        frame('screen'),
        frame('breakdown'),
      ]),
    );
    const [revision] = await revisions(card.id);
    expect(revision.frames.map((f) => [f.position, f.kind])).toEqual([
      [0, 'screen'],
      [1, 'breakdown'],
    ]);
    expect(revision.templateKey).toBe('page');
    expect(revision.conformance).toMatchObject({ ok: true });
    expect(await designTurns(card.id)).toHaveLength(1);
    const view = await h.cardDesign(card.number);
    expect(view.status).toBe('reviewing');
    expect(view.template.key).toBe('page');
  });

  it('starts exactly one repair turn naming the missing frame, which conforms', async () => {
    const card = await generated(null);
    await h.finishCard(
      card.id,
      designResult({ taskKey: KEY, variant: 1 }, [frame('screen')]),
    );
    const [first] = await revisions(card.id);
    expect(first.conformance).toEqual({
      ok: false,
      missing: ['breakdown'],
      extra: [],
      misplaced: [],
    });
    const turns = await designTurns(card.id);
    expect(turns).toHaveLength(2);
    expect(turns[1].phase).toBe('queued');
    const prompt = String(h.sentOf('plan.turn').at(-1)?.prompt);
    expect(prompt).toContain('## Repair');
    expect(prompt).toContain('Missing: "breakdown".');
    expect((await h.cardDesign(card.number)).status).toBe('generating');

    await h.finishCard(
      card.id,
      designResult({ taskKey: KEY, variant: 1, kept: ['screen'] }, [
        frame('screen'),
        frame('breakdown'),
      ]),
    );
    const [, repaired] = await revisions(card.id);
    expect(repaired.revision).toBe(2);
    expect(repaired.conformance).toMatchObject({ ok: true });
    expect(repaired.frames.map((f) => f.kind)).toEqual(['screen', 'breakdown']);
    const marked = await h.ctx.prisma.designRevision.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(marked.repairTurnId).toBe(turns[1].id);
    expect(await designTurns(card.id)).toHaveLength(2);
    expect((await h.cardDesign(card.number)).status).toBe('reviewing');
  });

  it('stores a repair that is off again as off, and starts no further turn', async () => {
    const card = await generated(null);
    const onlyScreen = designResult({ taskKey: KEY, variant: 1 }, [
      frame('screen'),
    ]);
    await h.finishCard(card.id, onlyScreen);
    await h.finishCard(card.id, onlyScreen);
    const [, second] = await revisions(card.id);
    expect(second.conformance).toEqual({
      ok: false,
      missing: ['breakdown'],
      extra: [],
      misplaced: [],
    });
    expect(await designTurns(card.id)).toHaveLength(2);
    const view = await h.cardDesign(card.number);
    expect(view.status).toBe('reviewing');
    expect(view.revisions.at(-1)?.conformance?.missing).toEqual(['breakdown']);
  });

  it('keeps every variant of a component design in the template order', async () => {
    const card = await generated('component', 3);
    for (const variant of [1, 2, 3]) {
      await h.finishCard(
        card.id,
        designResult({ taskKey: KEY, variant }, [
          frame('in_context'),
          frame('anatomy'),
          frame('state_grid'),
        ]),
      );
    }
    const stored = await revisions(card.id);
    expect(stored.map((r) => r.variant)).toEqual([1, 2, 3]);
    for (const r of stored) {
      expect(r.templateKey).toBe('component');
      expect(r.frames.map((f) => f.kind)).toEqual([
        'in_context',
        'anatomy',
        'state_grid',
      ]);
      expect(r.conformance).toMatchObject({ ok: true });
    }
  });

  it('carries the required frames a revise leaves out (D10)', async () => {
    const card = await generated('component');
    await h.finishCard(
      card.id,
      designResult({ taskKey: KEY, variant: 1 }, [
        frame('in_context'),
        frame('anatomy'),
        frame('state_grid'),
      ]),
    );
    const [drawn] = await revisions(card.id);
    expect(
      (
        await h.author.send('post', `${base(card.number)}/comments`, {
          revisionId: drawn.id,
          frame: 1,
          kind: 'general',
          body: 'Show the padding tokens.',
        })
      ).status,
    ).toBe(201);
    expect(
      (await h.author.send('post', `${base(card.number)}/revise`)).status,
    ).toBe(201);
    await h.finishCard(
      card.id,
      designResult({ taskKey: KEY, variant: 1 }, [
        frame('anatomy', 'Anatomy v2'),
      ]),
    );
    const [, revised] = await revisions(card.id);
    expect(revised.frames.map((f) => [f.name, f.kind])).toEqual([
      ['in_context', 'in_context'],
      ['Anatomy v2', 'anatomy'],
      ['state_grid', 'state_grid'],
    ]);
    expect(revised.conformance).toMatchObject({ ok: true });
    expect(await designTurns(card.id)).toHaveLength(2);
  });

  it('takes six flow steps, and marks seven too_many_steps without a repair', async () => {
    const card = await generated('flow');
    expect(String(h.sentOf('plan.turn').at(-1)?.prompt)).toContain(
      'If the flow needs more than 6 steps, draw the first 6.',
    );
    await h.finishCard(
      card.id,
      designResult({ taskKey: KEY, variant: 1 }, [
        frame('flow_map'),
        ...steps(7),
        frame('breakdown'),
      ]),
    );
    const [revision] = await revisions(card.id);
    expect(revision.conformance).toMatchObject({
      ok: false,
      reason: 'too_many_steps',
    });
    expect(revision.frames.slice(1, 3).map((f) => f.templateFrameKey)).toEqual([
      'flow_step-1',
      'flow_step-2',
    ]);
    expect(await designTurns(card.id)).toHaveLength(1);
    expect((await h.cardDesign(card.number)).status).toBe('reviewing');
  });

  it('accepts six flow steps as conforming', async () => {
    const card = await generated('flow');
    await h.finishCard(
      card.id,
      designResult({ taskKey: KEY, variant: 1 }, [
        frame('flow_map'),
        ...steps(6),
        frame('breakdown'),
      ]),
    );
    const [revision] = await revisions(card.id);
    expect(revision.conformance).toMatchObject({ ok: true });
  });

  it('Complete starts the repair turn by hand, audited', async () => {
    const card = await generated(null);
    const onlyScreen = designResult({ taskKey: KEY, variant: 1 }, [
      frame('screen'),
    ]);
    await h.finishCard(card.id, onlyScreen);
    await h.finishCard(card.id, onlyScreen);
    expect(await designTurns(card.id)).toHaveLength(2);

    expect(
      (await h.viewer.send('post', `${base(card.number)}/complete`)).status,
    ).toBe(403);
    const completed = await h.author.send(
      'post',
      `${base(card.number)}/complete`,
    );
    expect(completed.status).toBe(201);
    const turns = await designTurns(card.id);
    expect(turns).toHaveLength(3);
    expect(String(h.sentOf('plan.turn').at(-1)?.prompt)).toContain(
      'Missing: "breakdown".',
    );
    const [entry] = await h.auditOf('design.completed');
    expect(entry).toMatchObject({ result: 'ok' });

    await h.finishCard(
      card.id,
      designResult({ taskKey: KEY, variant: 1 }, [
        frame('screen'),
        frame('breakdown'),
      ]),
    );
    expect((await revisions(card.id)).at(-1)?.conformance).toMatchObject({
      ok: true,
    });
    // Nothing left off: a second Complete has nothing to do.
    expect(
      (await h.author.send('post', `${base(card.number)}/complete`)).status,
    ).toBe(409);
  });

  it('fails a design cut by an older runner, naming its version, and stores nothing', async () => {
    const card = await generated(null);
    await h.ctx.prisma.runner.update({
      where: { id: h.runnerId },
      data: { version: '0.14.0' },
    });
    const cut = designResult({ taskKey: KEY, variant: 1 }).slice(0, 400);
    expect(cut.length).toBeLessThan(PLAN_TURN_RESULT_TOTAL_MAX_BYTES);
    await h.finishCard(card.id, cut, { resultTruncated: true });
    const [turn] = await designTurns(card.id);
    expect(turn.phase).toBe('failed');
    expect(turn.error).toContain('runner 0.14.0 is too old');
    expect(turn.error).toContain('update the runner');
    expect(await revisions(card.id)).toHaveLength(0);
    expect((await h.cardDesign(card.number)).status).toBe('idle');
  });
});
