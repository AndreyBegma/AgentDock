import {
  BUILTIN_DESIGN_TEMPLATES,
  type DesignTemplateFrame,
  type DesignTemplatesView,
  type DesignTemplateView,
} from '@nautelle/shared';
import type { Prisma } from '@prisma/client';
import { CardDesignHarness } from '../design/testing/card-design-e2e';

const custom = (
  over: Partial<DesignTemplateFrame> = {},
): DesignTemplateFrame => ({
  key: 'notes',
  kind: 'custom',
  name: 'Release notes',
  instruction: 'Write the release notes for this page as a changelog.',
  required: false,
  enabled: true,
  ...over,
});

/**
 * #833 (ADR-0082): a project's design templates — list, save, reset, who may,
 * what a built-in may change, the audit trail, and that the prompt follows.
 */
describe('design templates API (e2e, #833)', () => {
  const h = new CardDesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const url = (key = '', projectId = h.projectId) =>
    `/projects/${projectId}/design/templates${key ? `/${key}` : ''}`;
  const page = BUILTIN_DESIGN_TEMPLATES[0];
  const list = async () =>
    (await h.viewer.get(url())).body as DesignTemplatesView;

  it('lists the built-ins for a member, and nothing is overridden', async () => {
    const res = await h.viewer.get(url());
    expect(res.status).toBe(200);
    const { templates } = res.body as DesignTemplatesView;
    expect(templates.map((t) => [t.key, t.builtin, t.overridden])).toEqual([
      ['page', true, false],
      ['component', true, false],
      ['flow', true, false],
    ]);
    expect(templates[0].frames.map((f) => f.key)).toEqual([
      'screen',
      'breakdown',
      'states',
    ]);
  });

  it('disables an optional built-in frame, and lists the override', async () => {
    const frames = page.frames.map((f) =>
      f.key === 'states' ? { ...f, enabled: false } : f,
    );
    const res = await h.admin.send('put', url('page'), {
      name: page.name,
      frames,
    });
    expect(res.status).toBe(200);
    const body = res.body as DesignTemplateView;
    expect(body).toMatchObject({
      key: 'page',
      builtin: true,
      overridden: true,
    });
    const listed = (await list()).templates.find((t) => t.key === 'page');
    expect(listed?.overridden).toBe(true);
    expect(listed?.frames.find((f) => f.key === 'states')?.enabled).toBe(false);
    expect((await h.auditOf('design.template_created')).length).toBe(1);
  });

  it('refuses removing a required built-in frame with 400', async () => {
    const res = await h.admin.send('put', url('page'), {
      name: page.name,
      frames: page.frames.filter((f) => f.key !== 'breakdown'),
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('breakdown');
    expect((await list()).templates[0].overridden).toBe(false);
  });

  it('refuses changing a built-in frame’s kind and an invalid definition', async () => {
    const renamed = await h.admin.send('put', url('page'), {
      name: page.name,
      frames: page.frames.map((f) =>
        f.key === 'screen' ? { ...f, name: 'Hero' } : f,
      ),
    });
    expect(renamed.status).toBe(400);
    const twice = await h.admin.send('put', url('landing'), {
      name: 'Landing',
      frames: [custom(), custom({ key: 'other' })],
    });
    expect(twice.status).toBe(400);
    const key = await h.admin.send('put', url('Bad.Key'), {
      name: 'Bad',
      frames: [custom()],
    });
    expect(key.status).toBe(400);
  });

  it('creates, updates and deletes a custom template, each audited', async () => {
    const created = await h.admin.send('put', url('landing'), {
      name: 'Landing',
      frames: [
        {
          key: 'screen',
          kind: 'screen',
          name: 'Hero',
          instruction: 'The landing page hero.',
          required: true,
          enabled: true,
        },
        custom(),
      ],
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      key: 'landing',
      builtin: false,
      overridden: true,
    });
    expect((await list()).templates.map((t) => t.key)).toEqual([
      'page',
      'component',
      'flow',
      'landing',
    ]);
    const updated = await h.admin.send('put', url('landing'), {
      name: 'Landing page',
      frames: [custom()],
    });
    expect(updated.status).toBe(200);
    expect((await list()).templates.at(-1)?.name).toBe('Landing page');
    expect((await h.admin.send('delete', url('landing'))).status).toBe(204);
    expect((await list()).templates).toHaveLength(3);
    expect((await h.admin.send('delete', url('landing'))).status).toBe(404);
    expect((await h.auditOf('design.template_created')).length).toBe(1);
    expect((await h.auditOf('design.template_updated')).length).toBe(1);
    expect((await h.auditOf('design.template_deleted')).length).toBe(1);
  });

  it('resets a built-in override on delete', async () => {
    await h.admin.send('put', url('page'), {
      name: page.name,
      frames: page.frames.map((f) =>
        f.key === 'states' ? { ...f, enabled: false } : f,
      ),
    });
    expect((await h.admin.send('delete', url('page'))).status).toBe(204);
    const listed = (await list()).templates[0];
    expect(listed.overridden).toBe(false);
    expect(listed.frames.find((f) => f.key === 'states')?.enabled).toBe(true);
    expect((await h.auditOf('design.template_deleted')).length).toBe(1);
    // Nothing left to reset: done, and not audited again.
    expect((await h.admin.send('delete', url('page'))).status).toBe(204);
    expect((await h.auditOf('design.template_deleted')).length).toBe(1);
  });

  // #863 (ADR-0085): an override stored while flow still had a mobile frame.
  it('lists an older flow override without its mobile frame, and saves it back', async () => {
    const flow = BUILTIN_DESIGN_TEMPLATES[2];
    const mobile: DesignTemplateFrame = {
      key: 'mobile',
      kind: 'mobile',
      name: 'Mobile',
      instruction: 'The steps at the narrow width.',
      required: false,
      enabled: true,
    };
    await h.ctx.prisma.designTemplate.create({
      data: {
        projectId: h.projectId,
        key: 'flow',
        name: flow.name,
        definition: {
          frames: [...flow.frames, mobile, custom()],
        } as unknown as Prisma.InputJsonValue,
      },
    });
    const listed = (await list()).templates.find((t) => t.key === 'flow');
    expect(listed?.overridden).toBe(true);
    expect(listed?.frames.map((f) => f.key)).toEqual([
      'flow_map',
      'flow_step',
      'breakdown',
      'notes',
    ]);
    const saved = await h.admin.send('put', url('flow'), {
      name: listed?.name,
      frames: listed?.frames,
    });
    expect(saved.status).toBe(200);
  });

  it('keeps the templates of one project from another’s members, and from an operator’s writes', async () => {
    expect((await h.outsider.get(url())).status).toBe(404);
    expect(
      (
        await h.outsider.send('put', url('landing'), {
          name: 'Landing',
          frames: [custom()],
        })
      ).status,
    ).toBe(404);
    for (const session of [h.author, h.viewer]) {
      expect(
        (
          await session.send('put', url('landing'), {
            name: 'Landing',
            frames: [custom()],
          })
        ).status,
      ).toBe(403);
      expect((await session.send('delete', url('page'))).status).toBe(403);
    }
    expect((await h.auditOf('design.template_created')).length).toBe(0);
  });

  describe('the design prompt', () => {
    const KEY_BASE = (number: number) => h.cardDesignBase(number);
    const promptFor = async (template: string) => {
      await h.seedProfile();
      const card = await h.designedCard(1);
      await h.ctx.prisma.boardCard.update({
        where: { id: card.id },
        data: { designTemplate: template },
      });
      expect(
        (await h.author.send('post', `${KEY_BASE(card.number)}/generate`))
          .status,
      ).toBe(201);
      return String(h.sentOf('plan.turn').at(-1)?.prompt);
    };

    it('drops a disabled optional frame', async () => {
      await h.admin.send('put', url('page'), {
        name: page.name,
        frames: page.frames.map((f) =>
          f.key === 'states' ? { ...f, enabled: false } : f,
        ),
      });
      const prompt = await promptFor('page');
      expect(prompt).toContain('# Frames to draw');
      expect(prompt).not.toContain('States — kind');
    });

    it('carries a custom template’s frames with their instructions', async () => {
      await h.admin.send('put', url('landing'), {
        name: 'Landing',
        frames: [
          {
            key: 'screen',
            kind: 'screen',
            name: 'Hero',
            instruction: 'The landing page hero.',
            required: true,
            enabled: true,
          },
          custom(),
        ],
      });
      const prompt = await promptFor('landing');
      expect(prompt).toContain('Template: "Landing" (`landing`)');
      expect(prompt).toContain('Release notes');
      expect(prompt).toContain('Write the release notes for this page');
    });
  });
});
