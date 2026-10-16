import type {
  PlanDetail,
  PlanListView,
  PlannerInstructionsView,
  PlannerSettingsView,
  PlanTaskVersionsView,
  RunPage,
  TaskPage,
} from '@agentdock/shared';
import { BudgetGate } from '../budgets/budget-gate';
import { capabilities } from '../runners/testing/runner-e2e';
import {
  block,
  decomposed,
  PlannerHarness,
  question,
  ROOT,
  task,
} from './testing/planner-e2e';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const writeOf = (taskKey: string, document: string) =>
  block({ action: 'write', taskKey, document, assumptions: [] });

/** The contract trims a document, so the fixtures carry no trailing newline. */
const BUG_DOC = '## Reproduction\n\n1. Export\n\nDepends on t1';
const FEATURE_DOC = '## Summary\n\nX\n\n## Acceptance criteria\n\n- [ ] works';

describe('planner (e2e)', () => {
  const h = new PlannerHarness();

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  /** t1 feature; t2 bug depending on t1, with a blocking question; t3 feature. */
  const threeTasks = () =>
    decomposed(h, [
      task('t1'),
      task('t2', {
        kind: 'bug',
        dependsOn: ['t1'],
        questions: [question('q1', true)],
      }),
      task('t3', { questions: [question('q2', false)] }),
    ]);

  /** Grills t2 until done and lets the chained write land. */
  const talkThroughT2 = async (planId: string) => {
    const turn = await h.author.send(
      'post',
      `${h.base(planId)}/tasks/t2/turns`,
      { answers: [{ questionId: 'q1', optionId: 'yes' }] },
    );
    expect(turn.status).toBe(201);
    await h.finish(
      planId,
      block({ action: 'grill', taskKey: 't2', questions: [], done: true }),
    );
    await h.finish(
      planId,
      block({
        action: 'write',
        taskKey: 't2',
        document: BUG_DOC,
        assumptions: [],
      }),
    );
  };

  const review = (
    planId: string,
    key: string,
    decision: string,
    comment?: string,
  ) =>
    h.author.send('post', `${h.base(planId)}/tasks/${key}/review`, {
      decision,
      ...(comment ? { comment } : {}),
    });

  describe('#445 token saver on plan.turn', () => {
    const runOf = async (planId: string) =>
      h.ctx.prisma.run.findUniqueOrThrow({
        where: { id: (await h.activeTurn(planId)).runId },
      });

    it('is absent for a runner that does not advertise it', async () => {
      const plan = await h.createPlan('batch');
      expect(h.sentOf('plan.turn')[0]).not.toHaveProperty('tokenSaver');
      expect((await runOf(plan.id)).tokenSaver).toBe(false);
    });

    it('carries the setting for a runner that advertises it', async () => {
      await h.ctx.prisma.runner.update({
        where: { id: h.runnerId },
        data: { capabilities: { ...capabilities, tokenSaver: true } },
      });
      const plan = await h.createPlan('batch');
      expect(h.sentOf('plan.turn')[0].tokenSaver).toEqual({
        enabled: true,
        mcpAllow: [],
      });
      expect((await runOf(plan.id)).tokenSaver).toBe(true);
    });
  });

  describe('the batch flow (D1–D8)', () => {
    it('creates, decomposes, refuses needs_talk, grills, writes, reviews and sends with issue_body', async () => {
      const created = await h.createPlan('batch');
      expect(created).toMatchObject({
        visibility: 'private',
        status: 'drafting',
        mode: 'batch',
        // #337 D9: the author's planning model, `sonnet` without a setting.
        model: 'sonnet',
        profileKey: 'claude-main',
        instructionsVersion: 1,
      });
      expect(created.activeTurnId).not.toBeNull();
      const [first] = h.sentOf('plan.turn');
      expect(first).toMatchObject({
        planId: created.id,
        root: ROOT,
        base: 'develop',
        profileKey: 'claude-main',
        model: 'sonnet',
        timeoutSec: 1200,
        session: { resume: false },
      });
      expect(first.prompt).toEqual(
        expect.stringMatching(
          /^GLOBAL INSTRUCTIONS v1[\s\S]*Action: `decompose`[\s\S]*Build an exporter/,
        ),
      );

      await h.finish(
        created.id,
        block({
          action: 'decompose',
          title: 'Exporter',
          tasks: [
            task('t1'),
            task('t2', {
              kind: 'bug',
              dependsOn: ['t1'],
              questions: [question('q1', true)],
            }),
            task('t3', { questions: [question('q2', false)] }),
          ],
        }),
      );
      let plan = await h.detail(created.id);
      expect(plan.title).toBe('Exporter');
      expect(plan.status).toBe('reviewing');
      expect(plan.tasks.map((t) => [t.key, t.status, t.blockingOpen])).toEqual([
        ['t1', 'ready', 0],
        ['t2', 'needs_talk', 1],
        ['t3', 'ready', 0],
      ]);
      expect(plan.graph.edges).toEqual([{ from: 't1', to: 't2' }]);

      const refused = await review(created.id, 't2', 'approve');
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: 'needs_talk' });
      const [denied] = await h.auditOf('plan.task_reviewed');
      expect(denied.result).toBe('denied');

      await talkThroughT2(created.id);
      const turns = h.sentOf('plan.turn');
      // The grill forks the plan session; the chained write resumes the fork.
      const planSession = (first.session as { id: string }).id;
      const grill = turns[1].session as Record<string, unknown>;
      expect(grill).toMatchObject({ resume: true, forkFrom: planSession });
      expect(grill.id).toMatch(UUID);
      expect(turns[2].session).toEqual({ id: grill.id, resume: true });
      expect(turns[2].prompt).toEqual(
        expect.stringContaining('Action: `write`'),
      );

      plan = await h.detail(created.id);
      const t2 = plan.tasks.find((t) => t.key === 't2');
      expect(t2).toMatchObject({ status: 'ready', document: BUG_DOC });
      expect(plan.turns.map((t) => [t.action, t.phase, t.taskKey])).toEqual([
        ['decompose', 'succeeded', null],
        ['grill', 'succeeded', 't2'],
        ['write', 'succeeded', 't2'],
      ]);

      expect((await review(created.id, 't1', 'approve')).status).toBe(200);
      expect((await review(created.id, 't2', 'approve')).status).toBe(200);
      expect((await review(created.id, 't3', 'reject')).status).toBe(200);

      const sent = await h.author.send('post', `${h.base(created.id)}/send`);
      expect(sent.status).toBe(200);
      plan = sent.body as PlanDetail;
      expect(plan).toMatchObject({ status: 'sent', visibility: 'project' });

      const issues = h.sentOf('issue.create');
      expect(issues.map((i) => [i.title, i.labels, i.queue])).toEqual([
        ['Task t1', ['enhancement'], false],
        ['Task t2', ['bug'], false],
      ]);
      expect(issues[1].body).toBe(
        '## Reproduction\n\n1. Export\n\nDepends on #101',
      );
      expect(issues[0].body).toContain('Summary of t1');
      expect(h.sentOf('plan.queue_issues')).toEqual([
        { projectId: h.projectId, numbers: [101, 102], readyLabel: 'cs:ready' },
      ]);
      expect(h.sentOf('plan.publish_specs')).toEqual([]);
      expect(h.sentOf('plan.close')).toHaveLength(1);
      expect(
        plan.tasks.map((t) => [
          t.key,
          t.status,
          t.issue?.number,
          t.issue?.liveStatus,
        ]),
      ).toEqual([
        ['t1', 'issued', 101, 'queued'],
        ['t2', 'issued', 102, 'queued'],
        ['t3', 'rejected', undefined, undefined],
      ]);

      const [sentAudit] = await h.auditOf('plan.sent');
      expect(sentAudit.targetId).toBe(created.id);
      expect(sentAudit.after).toMatchObject({
        specOutput: 'issue_body',
        issues: [101, 102],
        queued: [101, 102],
      });
      const shared = await h.auditOf('plan.shared');
      expect(shared.map((a) => a.after)).toEqual([
        { visibility: 'project', reason: 'send' },
      ]);
      expect((await h.auditOf('plan.created'))[0].targetId).toBe(created.id);
      expect(
        (await h.auditOf('plan.task_reviewed')).map((a) => [
          (a.after as { key: string }).key,
          a.result,
        ]),
      ).toEqual([
        ['t2', 'denied'],
        ['t1', 'ok'],
        ['t2', 'ok'],
        ['t3', 'ok'],
      ]);

      // A retry of a sent plan is a no-op (idempotent).
      const again = await h.author.send('post', `${h.base(created.id)}/send`);
      expect(again.status).toBe(200);
      expect(h.sentOf('issue.create')).toHaveLength(2);

      const tasks = (await h.author.get('/tasks')).body as TaskPage;
      expect(tasks.items.map((t) => [t.key, t.status])).toEqual(
        expect.arrayContaining([
          ['t1', 'queued'],
          ['t2', 'queued'],
          ['t3', 'rejected'],
        ]),
      );
    });

    it('publishes features as one docs pull request and queues them when it merges (docs_pr)', async () => {
      await h.ctx.prisma.project.update({
        where: { id: h.projectId },
        data: {
          codeSentinelConfig: { orchestrator: { specDir: 'docs/specs' } },
        },
      });
      const created = await threeTasks();
      await talkThroughT2(created.id);
      // t1 gets a written document too.
      await h.author.send('post', `${h.base(created.id)}/tasks/t1/turns`, {
        message: 'Write it up',
      });
      await h.finish(
        created.id,
        block({ action: 'grill', taskKey: 't1', questions: [], done: true }),
      );
      await h.finish(created.id, writeOf('t1', FEATURE_DOC));
      await review(created.id, 't1', 'approve');
      await review(created.id, 't2', 'approve');
      await review(created.id, 't3', 'reject');

      const settings = (
        await h.author.get(`/projects/${h.projectId}/planner/settings`)
      ).body as PlannerSettingsView;
      expect(settings.specOutput).toBe('docs_pr');

      const sent = await h.author.send('post', `${h.base(created.id)}/send`);
      expect(sent.status).toBe(200);
      const plan = sent.body as PlanDetail;
      const issues = h.sentOf('issue.create');
      expect(issues[0].body).toContain('`docs/specs/<this issue>-task-t1.md`');
      expect(issues[0].body).not.toContain('Acceptance criteria');
      expect(issues[1].body).toContain('Depends on #101');
      // Bugs are queued at once; features wait for the docs PR.
      expect(h.sentOf('plan.queue_issues')).toEqual([
        { projectId: h.projectId, numbers: [102], readyLabel: 'cs:ready' },
      ]);
      const [publish] = h.sentOf('plan.publish_specs');
      expect(publish).toMatchObject({
        planId: created.id,
        specDir: 'docs/specs',
        branch: expect.stringMatching(/^docs\/plan-[a-z0-9]{12}$/) as string,
        files: [{ path: 'docs/specs/101-task-t1.md', content: FEATURE_DOC }],
      });
      expect(plan).toMatchObject({
        docsPrNumber: 7,
        docsPrUrl: 'https://github.com/acme/widget/pull/7',
      });
      expect(
        plan.tasks.find((t) => t.key === 't1')?.issue?.liveStatus,
      ).toBeNull();

      await h.sinks.dispatch(h.runnerId, [
        h.event('pr.closed', {
          number: 7,
          branch: publish.branch,
          merged: true,
        }),
      ]);
      expect(h.sentOf('plan.queue_issues')[1]).toEqual({
        projectId: h.projectId,
        numbers: [101],
        readyLabel: 'cs:ready',
      });
      const after = await h.detail(created.id);
      expect(after.tasks.find((t) => t.key === 't1')?.issue?.liveStatus).toBe(
        'queued',
      );
    });

    it('refuses send with dependency_cycle and names the tasks', async () => {
      const plan = await decomposed(h, [
        task('t1', { dependsOn: ['t2'] }),
        task('t2', { dependsOn: ['t1'] }),
      ]);
      await review(plan.id, 't1', 'approve');
      await review(plan.id, 't2', 'approve');
      const refused = await h.author.send('post', `${h.base(plan.id)}/send`);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        error: 'dependency_cycle',
        message: expect.stringContaining('t1 → t2 → t1') as string,
      });
      expect(h.sentOf('issue.create')).toEqual([]);
    });

    it('refuses send while a task needs talk or nothing is approved', async () => {
      const plan = await threeTasks();
      const refused = await h.author.send('post', `${h.base(plan.id)}/send`);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: 'not_sendable' });
    });
  });

  describe('past rounds on turns (#184)', () => {
    it("carries each round on the turn that opened it: a task's first from decompose, the next from grill", async () => {
      const created = await threeTasks();
      const grillT2 = async (answer: string, questions: object[]) => {
        const turn = await h.author.send(
          'post',
          `${h.base(created.id)}/tasks/t2/turns`,
          { answers: [{ questionId: answer, optionId: 'yes' }] },
        );
        expect(turn.status).toBe(201);
        await h.finish(
          created.id,
          block({ action: 'grill', taskKey: 't2', questions, done: false }),
        );
      };
      await grillT2('q1', [question('q3', true)]);
      await grillT2('q3', [question('q4', false)]);

      const plan = await h.detail(created.id);
      expect(
        plan.turns.map((t) => [
          t.action,
          t.taskKey,
          t.input.answers?.map((a) => a.questionId) ?? [],
          t.rounds.map((r) => [r.taskKey, r.questions.map((q) => q.id)]),
        ]),
      ).toEqual([
        [
          'decompose',
          null,
          [],
          [
            ['t2', ['q1']],
            ['t3', ['q2']],
          ],
        ],
        ['grill', 't2', ['q1'], [['t2', ['q3']]]],
        ['grill', 't2', ['q3'], [['t2', ['q4']]]],
      ]);
      expect(plan.turns[0].rounds[0].questions[0]).toEqual(
        question('q1', true),
      );
      // The open round is still the task's own.
      const t2 = plan.tasks.find((t) => t.key === 't2');
      expect(t2?.questions.map((q) => q.id)).toEqual(['q4']);
    });

    it('opens no round for a grill that is done, nor for a write', async () => {
      const created = await threeTasks();
      await talkThroughT2(created.id);
      const plan = await h.detail(created.id);
      expect(plan.turns.map((t) => [t.action, t.rounds.length])).toEqual([
        ['decompose', 2],
        ['grill', 0],
        ['write', 0],
      ]);
    });
  });

  describe('revise (D9)', () => {
    it('passes frozen tasks through, drops rejected ones and bumps the version', async () => {
      const plan = await threeTasks();
      await review(plan.id, 't1', 'approve');
      await review(plan.id, 't2', 'reject');
      expect((await review(plan.id, 't3', 'rewrite')).status).toBe(400);
      await review(plan.id, 't3', 'rewrite', 'Split CSV and JSON');

      const revise = await h.author.send('post', `${h.base(plan.id)}/revise`);
      expect(revise.status).toBe(201);
      const [, prompt] = h.sentOf('plan.turn').map((t) => t.prompt as string);
      expect(prompt).toContain('## Frozen tasks\n\n- `t1`');
      expect(prompt).toContain('Split CSV and JSON');
      // Reviews wait while the revise turn runs.
      expect((await review(plan.id, 't1', 'reject')).status).toBe(409);

      await h.finish(
        plan.id,
        block({
          action: 'revise',
          tasks: [
            { key: 't1' },
            task('t3', { title: 'CSV export' }),
            task('t4', { title: 'JSON export', dependsOn: ['t3'] }),
          ],
        }),
      );
      const next = await h.detail(plan.id);
      expect(next.version).toBe(2);
      expect(
        next.tasks.map((t) => [
          t.key,
          t.status,
          t.frozen,
          t.title,
          t.planVersion,
        ]),
      ).toEqual([
        ['t1', 'approved', true, 'Task t1', 2],
        ['t3', 'ready', false, 'CSV export', 2],
        ['t4', 'ready', false, 'JSON export', 2],
      ]);
      // Earlier versions stay stored.
      expect(
        await h.ctx.prisma.planTask.count({
          where: { planId: plan.id, planVersion: 1 },
        }),
      ).toBe(3);
      const [revised] = await h.auditOf('plan.revised');
      expect(revised.after).toMatchObject({ fromVersion: 1, rewrites: ['t3'] });
    });

    it('keeps every version a task appeared in readable, each with the turn that produced it (#185)', async () => {
      const plan = await threeTasks();
      await talkThroughT2(plan.id);
      await review(plan.id, 't2', 'approve');
      await review(plan.id, 't3', 'reject');
      await review(plan.id, 't1', 'rewrite', 'Narrow it');
      await h.author.send('post', `${h.base(plan.id)}/revise`);
      await h.finish(
        plan.id,
        block({
          action: 'revise',
          tasks: [{ key: 't2' }, task('t1', { title: 'Narrower t1' })],
        }),
      );
      await review(plan.id, 't1', 'rewrite', 'Narrower still');
      await h.author.send('post', `${h.base(plan.id)}/revise`);
      // A revise that fails changes no version; its retry produces the next.
      await h.finish(plan.id, 'No block this time.');
      const failed = (await h.detail(plan.id)).turns.at(-1);
      expect(failed).toMatchObject({ action: 'revise', phase: 'failed' });
      await h.author.send(
        'post',
        `${h.base(plan.id)}/turns/${failed?.id}/retry`,
      );
      await h.finish(
        plan.id,
        block({
          action: 'revise',
          tasks: [{ key: 't2' }, task('t1', { title: 'Narrowest t1' })],
        }),
      );

      const detail = await h.detail(plan.id);
      expect(detail.version).toBe(3);
      const producers = [
        detail.turns.find((t) => t.action === 'decompose')?.id,
        ...detail.turns
          .filter((t) => t.action === 'revise' && t.phase === 'succeeded')
          .map((t) => t.id),
      ];
      expect(producers).toHaveLength(3);

      const versionsOf = async (key: string) => {
        const res = await h.author.get(
          `${h.base(plan.id)}/tasks/${key}/versions`,
        );
        expect(res.status).toBe(200);
        return res.body as PlanTaskVersionsView;
      };

      const t2 = await versionsOf('t2');
      expect(t2).toMatchObject({ key: 't2', currentVersion: 3 });
      expect(
        t2.versions.map((v) => [
          v.version,
          v.status,
          v.frozen,
          v.document,
          v.turn?.id,
        ]),
      ).toEqual([
        [1, 'approved', false, BUG_DOC, producers[0]],
        [2, 'approved', true, BUG_DOC, producers[1]],
        [3, 'approved', true, BUG_DOC, producers[2]],
      ]);
      expect(t2.versions.map((v) => v.turn?.action)).toEqual([
        'decompose',
        'revise',
        'revise',
      ]);

      const t1 = await versionsOf('t1');
      expect(
        t1.versions.map((v) => [
          v.version,
          v.status,
          v.title,
          v.rewriteComment,
        ]),
      ).toEqual([
        [1, 'rewrite_requested', 'Task t1', 'Narrow it'],
        [2, 'rewrite_requested', 'Narrower t1', 'Narrower still'],
        [3, 'ready', 'Narrowest t1', null],
      ]);

      // A rejected task is dropped by the next revise: its history ends there.
      const t3 = await versionsOf('t3');
      expect(t3.versions.map((v) => [v.version, v.status])).toEqual([
        [1, 'rejected'],
      ]);

      const missing = await h.author.get(
        `${h.base(plan.id)}/tasks/t9/versions`,
      );
      expect(missing.status).toBe(404);
    });
  });

  describe('contract violations and retry (D17)', () => {
    it('fails the turn, keeps resultText, changes no task; a retry runs it again', async () => {
      const plan = await h.createPlan('batch');
      await h.finish(plan.id, 'I could not decide on the tasks.');
      let detail = await h.detail(plan.id);
      const [failed] = detail.turns;
      expect(failed).toMatchObject({
        action: 'decompose',
        phase: 'failed',
        resultText: 'I could not decide on the tasks.',
        error: expect.stringMatching(
          /^contract_violation: no_block: /,
        ) as string,
      });
      expect(detail.tasks).toEqual([]);
      const run = await h.ctx.prisma.run.findUniqueOrThrow({
        where: { id: failed.runId },
      });
      expect(run).toMatchObject({ kind: 'plan', status: 'failed' });
      // #213: the failed plan is not "drafting" — the list and the detail say so.
      expect(detail.attention).toMatchObject({
        kind: 'failed',
        turnId: failed.id,
      });
      const listed = (await h.author.get(h.base())).body as PlanListView;
      expect(listed.items[0].attention).toMatchObject({
        kind: 'failed',
        turnId: failed.id,
        reason: expect.stringMatching(
          /^contract_violation: no_block/,
        ) as string,
      });

      const retry = await h.author.send(
        'post',
        `${h.base(plan.id)}/turns/${failed.id}/retry`,
      );
      expect(retry.status).toBe(201);
      const busy = await h.author.send(
        'post',
        `${h.base(plan.id)}/turns/${failed.id}/retry`,
      );
      expect(busy.status).toBe(409);
      expect(busy.body).toMatchObject({ error: 'turn_in_progress' });

      await h.finish(
        plan.id,
        block({ action: 'decompose', title: 'Exporter', tasks: [task('t1')] }),
      );
      detail = await h.detail(plan.id);
      expect(detail.tasks.map((t) => t.key)).toEqual(['t1']);
      expect(detail.attention).toBeNull();
      const succeeded = detail.turns[1];
      expect(succeeded).toMatchObject({
        action: 'decompose',
        phase: 'succeeded',
      });
      const notFailed = await h.author.send(
        'post',
        `${h.base(plan.id)}/turns/${succeeded.id}/retry`,
      );
      expect(notFailed.status).toBe(409);
      expect(notFailed.body).toMatchObject({ error: 'turn_not_failed' });
      expect(await h.auditOf('plan.revised')).toEqual([]);
    });

    it('retries a failed chained write turn on the same task', async () => {
      const plan = await decomposed(h, [task('t1')]);
      await h.author.send('post', `${h.base(plan.id)}/tasks/t1/turns`, {
        message: 'Go',
      });
      await h.finish(
        plan.id,
        block({ action: 'grill', taskKey: 't1', questions: [], done: true }),
      );
      // A feature document without acceptance criteria violates the contract.
      await h.finish(plan.id, writeOf('t1', '## Summary\n\nX'));
      let detail = await h.detail(plan.id);
      const write = detail.turns.at(-1);
      expect(write).toMatchObject({
        action: 'write',
        taskKey: 't1',
        phase: 'failed',
        error: expect.stringContaining('missing_acceptance_criteria') as string,
      });
      expect(detail.tasks[0].document).toBeNull();

      const retry = await h.author.send(
        'post',
        `${h.base(plan.id)}/turns/${write?.id}/retry`,
      );
      expect(retry.status).toBe(201);
      await h.finish(plan.id, writeOf('t1', FEATURE_DOC));
      detail = await h.detail(plan.id);
      expect(detail.tasks[0].document).toBe(FEATURE_DOC);
      expect(detail.turns.at(-1)).toMatchObject({
        action: 'write',
        taskKey: 't1',
        phase: 'succeeded',
      });
    });
  });

  describe('dialogue mode (D2)', () => {
    it('asks plan-level rounds, then chains the decompose turn', async () => {
      const plan = await h.createPlan('dialogue');
      expect(plan.status).toBe('clarifying');
      expect(h.sentOf('plan.turn')[0].prompt).toContain('Action: `clarify`');
      await h.finish(
        plan.id,
        block({
          action: 'clarify',
          questions: [question('p1', true)],
          done: false,
        }),
      );
      const round = (await h.detail(plan.id)).questions;
      expect(round.map((q) => q.id)).toEqual(['p1']);

      const answer = await h.author.send('post', `${h.base(plan.id)}/turns`, {
        answers: [{ questionId: 'p1', text: 'Only CSV' }],
      });
      expect(answer.status).toBe(201);
      const second = h.sentOf('plan.turn')[1];
      expect(second.session).toMatchObject({ resume: true });
      expect(second.prompt).toContain('p1 — Question p1: answer: Only CSV');

      await h.finish(
        plan.id,
        block({ action: 'clarify', questions: [], done: true }),
      );
      const third = h.sentOf('plan.turn')[2];
      expect(third.prompt).toContain('Action: `decompose`');
      expect((await h.detail(plan.id)).status).toBe('drafting');
    });
  });

  describe('runs, cost and budgets (D14)', () => {
    it('records each turn as a run of kind plan, with the cost of its session', async () => {
      const plan = await h.createPlan('batch');
      const turn = await h.activeTurn(plan.id);
      const run = await h.ctx.prisma.run.findUniqueOrThrow({
        where: { id: turn.runId },
      });
      const session = await h.ctx.prisma.agentSession.create({
        data: {
          runnerId: h.runnerId,
          runtime: 'claude',
          externalId: (h.sentOf('plan.turn')[0].session as { id: string }).id,
          cwd: '/srv/dev/.wt-widget-plan-abc',
          startedAt: run.startedAt,
          lastEventAt: run.startedAt,
        },
      });
      await h.ctx.prisma.llmRequest.create({
        data: {
          sessionId: session.id,
          requestId: 'r1',
          ts: new Date(run.startedAt.getTime() + 1),
          model: 'claude-opus-4-1',
          querySource: 'main',
          input: 1000,
          costUsd: '1.5',
        },
      });
      await h.finish(
        plan.id,
        block({ action: 'decompose', title: 'Exporter', tasks: [task('t1')] }),
        { at: new Date(run.startedAt.getTime() + 60_000) },
      );
      const runs = (
        await h.author.get(`/projects/${h.projectId}/runs?kind=plan`)
      ).body as RunPage;
      expect(runs.items).toHaveLength(1);
      expect(runs.items[0]).toMatchObject({
        id: run.id,
        kind: 'plan',
        status: 'succeeded',
        model: 'sonnet',
        profileKey: 'claude-main',
        triggeredByType: 'user',
        triggeredById: h.authorId,
        usage: { requests: 1, input: 1000, costUsd: '1.500000' },
      });
    });

    it('refuses a plan turn when a budget refuses runs, and sends nothing', async () => {
      const plan = await threeTasks();
      jest.spyOn(h.ctx.app.get(BudgetGate), 'check').mockResolvedValue({
        allowed: false,
        budgetId: 'budget-1',
        scope: 'project',
        resetsAt: new Date('2026-11-01T00:00:00Z'),
      });
      const before = h.sentOf('plan.turn').length;
      const refused = await h.author.send(
        'post',
        `${h.base(plan.id)}/tasks/t2/turns`,
        { message: 'Talk' },
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: 'budget_exceeded' });
      expect(h.sentOf('plan.turn')).toHaveLength(before);
      const created = await h.author.send('post', h.base(), {
        brief: 'Another',
        mode: 'batch',
      });
      expect(created.status).toBe(409);
    });

    it('refuses a codex profile with no_profile', async () => {
      const refused = await h.author.send('post', h.base(), {
        brief: 'Plan it',
        mode: 'batch',
        profileKey: 'codex-main',
      });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        error: 'no_profile',
        reason: 'not_claude',
        source: 'explicit',
      });
    });
  });

  describe('runner command advert (#233)', () => {
    it('refuses a plan with runner_outdated when the runner does not serve plan.turn, writing and sending nothing', async () => {
      h.advert = { commands: ['worktree.status'], disabled: [] };
      const refused = await h.author.send('post', h.base(), {
        brief: 'Plan it',
        mode: 'batch',
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: 'runner_outdated' });
      expect(refused.body.message).toContain('plan.turn');
      expect(await h.ctx.prisma.plan.count()).toBe(0);
      expect(h.sent).toEqual([]);
    });

    it('refuses a turn of an existing plan once the runner stops serving plan.turn', async () => {
      const plan = await threeTasks();
      const before = h.sent.length;
      h.advert = { commands: ['worktree.status'], disabled: [] };
      const refused = await h.author.send(
        'post',
        `${h.base(plan.id)}/tasks/t2/turns`,
        { message: 'Talk' },
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: 'runner_outdated' });
      expect(h.sent).toHaveLength(before);
    });

    it('leaves the runner to answer when it advertised nothing, or turned plan.turn off', async () => {
      // `createPlan` throws on anything but 201.
      await h.createPlan('batch');
      h.advert = { commands: ['plan.turn'], disabled: ['plan.turn'] };
      await h.createPlan('batch');
      expect(await h.ctx.prisma.plan.count()).toBe(2);
      expect(h.sentOf('plan.turn')).toHaveLength(2);
    });
  });

  describe('instructions and settings (D10, D11)', () => {
    it('versions the global instructions; a site admin only', async () => {
      const forbidden = await h.author.get('/admin/planner/instructions');
      expect(forbidden.status).toBe(403);
      const put = await h.admin.send('put', '/admin/planner/instructions', {
        body: 'GLOBAL v2',
      });
      expect(put.status).toBe(200);
      const view = put.body as PlannerInstructionsView;
      expect(view.current).toMatchObject({ version: 2, body: 'GLOBAL v2' });
      expect(view.versions.map((v) => v.version)).toEqual([2, 1]);
      expect(view.contract).toContain('agentdock-plan');
      const [audit] = await h.auditOf('planner.instructions_updated');
      expect(audit.after).toEqual({ scope: 'global', version: 2 });

      // A new plan records the version it runs with.
      const plan = await h.createPlan('batch');
      expect(plan.instructionsVersion).toBe(2);
    });

    it('sets, uses and clears a project override; docs_pr needs a specDir', async () => {
      const url = `/projects/${h.projectId}/planner/settings`;
      const refused = await h.admin.send('put', url, { specOutput: 'docs_pr' });
      expect(refused.status).toBe(422);

      const set = await h.admin.send('put', url, {
        specOutput: 'issue_body',
        instructionsOverride: 'PROJECT v1',
      });
      expect(set.status).toBe(200);
      expect((set.body as PlannerSettingsView).override).toMatchObject({
        version: 1,
        body: 'PROJECT v1',
      });
      const plan = await h.createPlan('batch');
      expect(h.sentOf('plan.turn')[0].prompt).toMatch(/^PROJECT v1/);
      expect(plan.instructionsVersion).toBe(1);

      const cleared = await h.admin.send('put', url, {
        specOutput: 'issue_body',
        instructionsOverride: '',
      });
      const view = cleared.body as PlannerSettingsView;
      expect(view.override).toBeNull();
      expect(view.overrideVersions.map((v) => v.version)).toEqual([1]);
      const audits = await h.auditOf('planner.settings_updated');
      expect(audits.map((a) => a.result)).toEqual(['ok', 'ok']);
      expect(audits[1].after).toMatchObject({ overrideInstructionsId: null });
    });
  });
});
