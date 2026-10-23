import type {
  PrefixOverlayDetailView,
  PrefixOverlayView,
  PrefixSummaryView,
} from '@nautelle/shared';
import { BoardWorld, ROOT_B } from '../board/testing/board-e2e';
import { capabilities } from '../runners/testing/runner-e2e';
import { PrefixCommands } from './prefix-commands';
import { PrefixProposer } from './prefix-proposer';
import { PrefixQueues } from './prefix-queues';
import { RulesCompressor } from './rules-compressor';
import { enabledRules, sha256Of } from './rules-version';

const ORIGINAL =
  '# Widget\n\nAlways run the tests. Always run the tests before a commit.\n';
const SHORTER = '# Widget\n\nRun the tests before a commit.\n';

describe('the launch prefix (e2e, #751)', () => {
  const w = new BoardWorld();
  let commands: PrefixCommands;
  let proposer: PrefixProposer;
  let compressor: RulesCompressor;
  let queues: PrefixQueues;
  let proposeAnswer: Awaited<ReturnType<PrefixCommands['propose']>>;
  let compressAnswer: (prompt: string) => string;

  beforeAll(async () => {
    await w.init();
    commands = w.ctx.app.get(PrefixCommands);
    proposer = w.ctx.app.get(PrefixProposer);
    compressor = w.ctx.app.get(RulesCompressor);
    queues = w.ctx.app.get(PrefixQueues);
    jest.spyOn(commands, 'state').mockImplementation(() => 'ready');
    jest
      .spyOn(commands, 'propose')
      .mockImplementation(async () => proposeAnswer);
    jest.spyOn(commands, 'compress').mockImplementation(async (_r, args) => ({
      status: 'ok',
      output: {
        resultText: compressAnswer(args.prompt),
        resultTruncated: false,
      },
    }));
  });
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    await queues.compress?.obliterate({ force: true });
    await queues.propose?.obliterate({ force: true });
    proposeAnswer = {
      status: 'ok',
      output: {
        path: 'CLAUDE.md',
        originalSha256: sha256Of(ORIGINAL),
        originalText: ORIGINAL,
        proposedText: SHORTER,
      },
    };
    compressAnswer = () => '{"rules":[]}';
  });
  afterEach(() => w.work.settled());

  const RANGE = 'from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z';
  const summaryPath = (projectId = w.a) =>
    `/projects/${projectId}/token-saver/prefix?${RANGE}`;
  const overlays = (projectId = w.a) =>
    `/projects/${projectId}/prefix/overlays`;

  /** The runner advertises the token saver, the techniques and the prefix. */
  const advertise = () =>
    w.ctx.prisma.runner.update({
      where: { id: w.runnerId },
      data: {
        capabilities: {
          ...capabilities,
          tokenSaver: true,
          tokenEconomy: true,
          prefixMeasure: true,
          prefixOverlays: true,
        },
      },
    });

  const run = (projectId = w.a) =>
    w.ctx.prisma.run.create({
      data: {
        kind: 'card',
        projectId,
        title: 'C-1',
        runtime: 'claude',
        status: 'running',
        triggeredByType: 'user',
        startedAt: new Date(),
        updatedAt: new Date(),
      },
      select: { id: true },
    });

  const part = (over: Record<string, unknown> = {}) => ({
    kind: 'claude_md',
    name: 'CLAUDE.md',
    path: 'CLAUDE.md',
    origin: 'repo',
    bytes: 120_000,
    estTokens: 30_000,
    sha256: sha256Of(ORIGINAL),
    ...over,
  });

  const measured = (runId: string, parts = [part()], root?: string) =>
    w.deliver(
      'prefix.measured',
      { runId, launchKind: 'card', parts },
      root ? { project: { repo: 'acme/widget', root } } : {},
    );

  /** A proposed CLAUDE.md overlay, stored by a processed proposal job. */
  const proposed = async (): Promise<string> => {
    const outcome = await proposer.process({
      projectId: w.a,
      part: 'claude_md',
      userId: null,
    });
    expect(outcome.kind).toBe('stored');
    return outcome.kind === 'stored' ? outcome.overlayId : '';
  };

  const approved = async (): Promise<string> => {
    const id = await proposed();
    const response = await w.admin.send(
      'post',
      `${overlays()}/${id}/approve`,
      {},
    );
    expect(response.status).toBe(200);
    return id;
  };

  describe('the measurement (B1, B13)', () => {
    it('stores a launch’s parts once, and drops another project’s run', async () => {
      const own = await run();
      await measured(own.id, [
        part(),
        part({ kind: 'mcp', name: 'github', path: '', origin: 'profile' }),
      ]);
      await measured(own.id, [part()]);
      expect(
        await w.ctx.prisma.runPrefixPart.count({ where: { runId: own.id } }),
      ).toBe(2);
      const theirs = await run(w.b);
      await measured(theirs.id);
      expect(
        await w.ctx.prisma.runPrefixPart.count({ where: { runId: theirs.id } }),
      ).toBe(0);
      // The same run, from its own project's root, is kept.
      await measured(theirs.id, [part()], ROOT_B);
      expect(
        await w.ctx.prisma.runPrefixPart.count({ where: { runId: theirs.id } }),
      ).toBe(1);
    });

    it('lists the top parts and flags the kind over budget; the budget moves the flag', async () => {
      await measured((await run()).id);
      const first = await w.viewer.get(summaryPath());
      expect(first.status).toBe(200);
      const view = first.body as PrefixSummaryView;
      expect(view.budgetTokens).toBe(25_000);
      expect(view.kinds).toEqual([
        expect.objectContaining({ launchKind: 'card', overBudget: true }),
      ]);
      expect(view.topParts[0]).toMatchObject({
        name: 'CLAUDE.md',
        origin: 'repo',
        overlayPart: 'claude_md',
        overlay: null,
      });
      const put = await w.admin.send('put', `/projects/${w.a}/token-saver`, {
        enabled: true,
        mcpAllow: [],
        prefixBudgetTokens: 50_000,
      });
      expect(put.status).toBe(200);
      const after = (await w.viewer.get(summaryPath()))
        .body as PrefixSummaryView;
      expect(after.kinds[0]?.overBudget).toBe(false);
    });

    it('an over-budget kind queues one automatic proposal for its largest repo part', async () => {
      await measured((await run()).id);
      await measured((await run()).id);
      const jobs =
        (await queues.propose?.getJobs(['waiting', 'delayed'])) ?? [];
      expect(jobs.map((j) => j.data.part)).toEqual(['claude_md']);
    });
  });

  describe('overlays (B7–B10, B12)', () => {
    it('a proposal stores the original text and hash; approve makes it the open one', async () => {
      const id = await proposed();
      const detail = (await w.admin.get(`${overlays()}/${id}`))
        .body as PrefixOverlayDetailView;
      expect(detail).toMatchObject({
        part: 'claude_md',
        state: 'proposed',
        originalSha256: sha256Of(ORIGINAL),
        originalText: ORIGINAL,
        content: SHORTER,
      });
      expect(
        (await w.admin.send('post', `${overlays()}/${id}/approve`, {})).body,
      ).toMatchObject({ state: 'approved' });
      expect(
        (await w.admin.send('post', `${overlays()}/${id}/reject`, {})).status,
      ).toBe(409);
      const [record] = await w.audit('project.prefix_overlay');
      expect(record?.meta).toMatchObject({
        change: 'approved',
        part: 'claude_md',
      });
    });

    it('a refused path stores nothing and fails the run with policy_refused', async () => {
      proposeAnswer = {
        status: 'error',
        code: 'policy_refused',
        message: 'policy_refused — CLAUDE.md is denied',
      };
      const outcome = await proposer.process({
        projectId: w.a,
        part: 'claude_md',
        userId: null,
      });
      expect(outcome).toMatchObject({ kind: 'failed' });
      expect(await w.ctx.prisma.prefixOverlay.count()).toBe(0);
      const failed = await w.ctx.prisma.run.findFirstOrThrow({
        where: { kind: 'prefix_propose' },
      });
      expect(failed.status).toBe('failed');
      expect(failed.outcome).toContain('policy_refused');
    });

    it('Propose queues a job; a part with an open overlay is refused', async () => {
      const queued = await w.admin.send('post', `${overlays()}/propose`, {
        part: 'claude_md',
      });
      expect(queued.status).toBe(202);
      await proposed();
      const again = await w.admin.send('post', `${overlays()}/propose`, {
        part: 'claude_md',
      });
      expect(again.status).toBe(409);
      const bad = await w.admin.send('post', `${overlays()}/propose`, {
        part: 'rules',
      });
      expect(bad.status).toBe(400);
    });

    it('an approved overlay goes to the B arm’s launch, never to the A arm', async () => {
      await advertise();
      const id = await approved();
      await w.createCard();
      expect((await w.runCard(1)).status).toBe(200);
      await w.technique('prefix-overlays', 'on');
      await w.createCard();
      expect((await w.runCard(2)).status).toBe(200);
      const [a, b] = w.sent('card.run');
      const prefixOf = (args?: Record<string, unknown>) =>
        (args?.tokenSaver as { prefix?: { overlays: unknown[] } }).prefix;
      expect(prefixOf(a)?.overlays).toEqual([]);
      expect(prefixOf(b)?.overlays).toEqual([
        {
          id,
          part: 'claude_md',
          originalSha256: sha256Of(ORIGINAL),
          content: SHORTER,
        },
      ]);
      const card = await w.card(2);
      expect(card.sessionCardType).toBe('feature');
      expect(card.sessionPrefix).toMatchObject({ overlayIds: [id] });
    });

    it('a stale report marks the overlay stale, queues a proposal, and it is never sent again', async () => {
      await advertise();
      await w.technique('prefix-overlays', 'on');
      const id = await approved();
      const launched = await run();
      await w.deliver('prefix.overlay_stale', {
        runId: launched.id,
        overlayId: id,
        sha256: 'c'.repeat(64),
      });
      expect(
        (await w.ctx.prisma.prefixOverlay.findUniqueOrThrow({ where: { id } }))
          .state,
      ).toBe('stale');
      const jobs =
        (await queues.propose?.getJobs(['waiting', 'delayed'])) ?? [];
      expect(jobs.map((j) => j.data.part)).toEqual(['claude_md']);
      await w.createCard();
      expect((await w.runCard(1)).status).toBe(200);
      const [sent] = w.sent('card.run');
      expect(
        (sent?.tokenSaver as { prefix: { overlays: unknown[] } }).prefix
          .overlays,
      ).toEqual([]);
    });

    it('Open a pull request makes one Board card with the overlay attached', async () => {
      const id = await approved();
      const path = `${overlays()}/${id}/pull-request`;
      const first = await w.admin.send('post', path, {});
      expect(first.status).toBe(201);
      const second = await w.admin.send('post', path, {});
      expect(second.body).toEqual(first.body);
      const card = await w.ctx.prisma.boardCard.findUniqueOrThrow({
        where: { id: (first.body as { cardId: string }).cardId },
        include: { attachments: true },
      });
      expect(card.title).toContain('CLAUDE.md');
      expect(card.attachments).toHaveLength(1);
      expect(
        await w.ctx.prisma.boardCard.count({ where: { projectId: w.a } }),
      ).toBe(1);
      expect(w.sent('card.run')).toHaveLength(0);
    });
  });

  describe('rules (B5, B6)', () => {
    const rule = async (title: string, appliesTo: string[] = []) => {
      const created = await w.admin.send('post', `/projects/${w.a}/rules`, {
        title,
        description: `${title}: a long description that the model can shorten a lot.`,
      });
      expect(created.status).toBe(201);
      const id = (created.body as { id: string }).id;
      if (appliesTo.length > 0) {
        const patched = await w.admin.send(
          'patch',
          `/projects/${w.a}/rules/${id}`,
          { appliesTo },
        );
        expect(patched.status).toBe(200);
        expect(patched.body).toMatchObject({ appliesTo });
      }
      return id;
    };

    it('refuses an unknown card type', async () => {
      const id = await rule('Bun only');
      const response = await w.admin.send(
        'patch',
        `/projects/${w.a}/rules/${id}`,
        { appliesTo: ['chore'] },
      );
      expect(response.status).toBe(400);
    });

    it('a rules change makes one compression per version; B uses it once approved, A never', async () => {
      await advertise();
      await rule('Bun only');
      await rule('Bug repro first', ['bug']);
      // The writes queue their versions; only the current one runs.
      const jobs =
        (await queues.compress?.getJobs(['delayed', 'waiting'])) ?? [];
      const { version } = await enabledRules(w.ctx.prisma, w.a);
      expect(jobs.map((j) => j.data.rulesVersion)).toContain(version);
      compressAnswer = (prompt) => {
        const listed = prompt.slice(prompt.indexOf('The rules:'));
        const ids = [...listed.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
        return JSON.stringify({
          rules: ids.map((id) => ({ id, description: 'Short.' })),
        });
      };
      for (const job of jobs) await compressor.process(job.data);
      expect(
        await w.ctx.prisma.run.count({ where: { kind: 'rules_compress' } }),
      ).toBe(1);
      expect(
        await compressor.process({
          projectId: w.a,
          rulesVersion: version,
          userId: null,
        }),
      ).toMatchObject({ kind: 'skipped' });
      const [overlay] = (await w.viewer.get(overlays()))
        .body as PrefixOverlayView[];
      expect(overlay).toMatchObject({ part: 'rules', state: 'proposed' });

      // Proposed: the B arm still launches with the originals.
      await w.technique('rules-compressed', 'on');
      await w.createCard();
      expect((await w.runCard(1)).status).toBe(200);
      await w.admin.send('post', `${overlays()}/${overlay?.id}/approve`, {});
      await w.createCard();
      expect((await w.runCard(2)).status).toBe(200);
      await w.technique('rules-compressed', 'off');
      await w.createCard();
      expect((await w.runCard(3)).status).toBe(200);
      const [proposedRun, compressedRun, aRun] = w
        .sent('card.run')
        .map((args) => String(args.prompt));
      expect(proposedRun).toContain('a long description');
      expect(compressedRun).toContain('Short.');
      expect(compressedRun).not.toContain('a long description');
      expect(aRun).toContain('a long description');
    });

    it('in the prefix-select B arm a bug card gets only its rules and servers', async () => {
      await advertise();
      await rule('Everyone');
      await rule('Bug repro first', ['bug']);
      await rule('Screens follow the kit', ['ui']);
      const put = await w.admin.send('put', `/projects/${w.a}/token-saver`, {
        enabled: true,
        mcpAllow: ['github', 'linear'],
        mcpByType: { bug: ['github'] },
      });
      expect(put.status).toBe(200);
      const wider = await w.admin.send('put', `/projects/${w.a}/token-saver`, {
        enabled: true,
        mcpAllow: ['github'],
        mcpByType: { bug: ['figma'] },
      });
      expect(wider.status).toBe(400);
      const unknownSkill = await w.admin.send(
        'put',
        `/projects/${w.a}/token-saver`,
        {
          enabled: true,
          mcpAllow: ['github', 'linear'],
          skillsOffByType: { bug: ['never-reported'] },
        },
      );
      expect(unknownSkill.status).toBe(400);
      await w.technique('prefix-select', 'on');
      await w.createCard({ kind: 'bug' });
      expect((await w.runCard(1)).status).toBe(200);
      const [sent] = w.sent('card.run');
      const prompt = String(sent?.prompt);
      expect(prompt).toContain('Everyone');
      expect(prompt).toContain('Bug repro first');
      expect(prompt).not.toContain('Screens follow the kit');
      expect(sent?.tokenSaver).toMatchObject({
        mcpAllow: ['github', 'linear'],
        prefix: { cardType: 'bug', mcpAllow: ['github'], skillsOff: [] },
      });
    });
  });

  describe('authorization (B13)', () => {
    it("a member of B gets 404 from A's prefix summary and overlays", async () => {
      const id = await proposed();
      for (const path of [summaryPath(), overlays(), `${overlays()}/${id}`]) {
        expect((await w.operatorOfB.get(path)).status).toBe(404);
        expect((await w.outsider.get(path)).status).toBe(404);
      }
      expect(
        (await w.operatorOfB.send('post', `${overlays()}/${id}/approve`, {}))
          .status,
      ).toBe(404);
    });

    it('a viewer of A reads overlay metadata, and gets 403 on content and every action', async () => {
      const id = await proposed();
      const list = await w.viewer.get(overlays());
      expect(list.status).toBe(200);
      expect(list.body[0]).not.toHaveProperty('content');
      expect(list.body[0]).not.toHaveProperty('originalText');
      expect((await w.viewer.get(`${overlays()}/${id}`)).status).toBe(403);
      for (const action of ['approve', 'reject', 'pull-request']) {
        expect(
          (await w.viewer.send('post', `${overlays()}/${id}/${action}`, {}))
            .status,
        ).toBe(403);
      }
      expect(
        (
          await w.viewer.send('post', `${overlays()}/propose`, {
            part: 'claude_md',
          })
        ).status,
      ).toBe(403);
    });

    it('an overlay id of another project is not found in this one', async () => {
      const id = await proposed();
      expect((await w.admin.get(`${overlays(w.b)}/${id}`)).status).toBe(404);
    });
  });
});
