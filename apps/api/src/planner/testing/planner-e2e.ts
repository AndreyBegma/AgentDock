import { PLANNER_BLOCK_TAG, type PlanDetail } from '@agentdock/shared';
import {
  commandSupport,
  type DocsCommandName,
  type IssueCreateArgs,
  type IssueCreateResult,
  type PlannerCommandName,
  type RunnerCommands,
  type RunnerEvent,
} from '@agentdock/shared/protocol';
import { seedProject } from '../../fleet/testing/fleet-e2e';
import { RunnerEventSinks } from '../../runners/runner-event-sinks';
import { RunnerPresence } from '../../runners/runner-presence';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../../test/e2e-app';
import { PlannerCommands, type PlannerSendResult } from '../planner-commands';

export const ROOT = '/srv/dev/widget';
export const REPO = 'acme/widget';
export const PROFILE = 'claude-main';

/** A turn's final message holding one contract block (D17). */
export const block = (output: object): string =>
  `Here is the result.\n\n\`\`\`${PLANNER_BLOCK_TAG}\n${JSON.stringify(output)}\n\`\`\`\n`;

/** A question as the planner writes one (D7). */
export const question = (id: string, blocking: boolean) => ({
  id,
  title: `Question ${id}`,
  question: `What about ${id}?`,
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  recommendation: { optionId: 'yes', text: 'Yes', why: 'it is simpler' },
  blocking,
});

type Handler = (args: unknown) => PlannerSendResult<unknown>;
export const ok = <T>(output: T) => ({ status: 'ok' as const, output });

export interface SentCommand {
  name: PlannerCommandName | DocsCommandName | 'issue.create';
  args: Record<string, unknown>;
}

/**
 * The app with a stubbed runner: `PlannerCommands` answers from `handlers`
 * and records what was sent; turn results arrive as `plan_turn.*` events
 * through the real sinks. Users: `author` and `other` (operators of the
 * project), `viewer`, `outsider` (an operator of no project) and `admin`.
 */
export class PlannerHarness {
  ctx!: E2eContext;
  sinks!: RunnerEventSinks;
  commands!: PlannerCommands;
  presence!: RunnerPresence;
  /** What the runner's hello advertised (#233); null = unknown. */
  advert: RunnerCommands | null = null;
  runnerId!: string;
  projectId!: string;
  author!: Session;
  other!: Session;
  viewer!: Session;
  outsider!: Session;
  admin!: Session;
  authorId!: string;
  sent: SentCommand[] = [];
  handlers: Partial<Record<PlannerCommandName | DocsCommandName, Handler>> = {};
  private seq = 0;
  private issue = 100;
  private auditFrom = 0n;

  async start(): Promise<void> {
    this.ctx = await createE2eApp();
    this.sinks = this.ctx.app.get(RunnerEventSinks);
    this.commands = this.ctx.app.get(PlannerCommands);
    this.presence = this.ctx.app.get(RunnerPresence);
  }

  async reset(): Promise<void> {
    const { prisma } = this.ctx;
    await resetDatabase(prisma);
    await prisma.plannerInstructions.deleteMany({});
    ({ runnerId: this.runnerId, projectId: this.projectId } = await seedProject(
      prisma,
      ROOT,
    ));
    const profile = await prisma.runtimeProfile.create({
      data: {
        runnerId: this.runnerId,
        key: PROFILE,
        runtime: 'claude',
        label: 'Claude',
        env: {},
        args: [],
        authenticated: true,
      },
    });
    await prisma.runtimeProfile.create({
      data: {
        runnerId: this.runnerId,
        key: 'codex-main',
        runtime: 'codex',
        label: 'Codex',
        env: {},
        args: [],
        authenticated: true,
      },
    });
    await prisma.project.update({
      where: { id: this.projectId },
      data: { defaultProfileId: profile.id },
    });
    await prisma.plannerInstructions.create({
      data: { projectId: null, version: 1, body: 'GLOBAL INSTRUCTIONS v1' },
    });

    const member = async (email: string, role: 'viewer' | 'operator') => {
      const user = await createUser(prisma, email, role);
      await prisma.projectMember.create({
        data: { projectId: this.projectId, userId: user.id },
      });
      return user;
    };
    this.authorId = (await member('author@example.com', 'operator')).id;
    await member('other@example.com', 'operator');
    await member('viewer@example.com', 'viewer');
    await createUser(prisma, 'outsider@example.com', 'operator');
    await createUser(prisma, 'admin@example.com', 'admin');
    this.author = await login(this.ctx, 'author@example.com');
    this.other = await login(this.ctx, 'other@example.com');
    this.viewer = await login(this.ctx, 'viewer@example.com');
    this.outsider = await login(this.ctx, 'outsider@example.com');
    this.admin = await login(this.ctx, 'admin@example.com');

    const last = await prisma.auditRecord.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    this.auditFrom = last?.seq ?? 0n;
    this.seq = 0;
    this.issue = 100;
    this.sent = [];
    this.handlers = {
      'plan.turn': () => ok({ phase: 'queued' }),
      'plan.cancel': () => ok({ cancelled: true }),
      'plan.close': () => ok({ removed: true }),
      'plan.queue_issues': (args) =>
        ok({ labelled: (args as { numbers: number[] }).numbers }),
      'plan.publish_specs': () =>
        ok({ prNumber: 7, prUrl: `https://github.com/${REPO}/pull/7` }),
      'docs.publish_specs': () =>
        ok({
          repo: 'acme/widget-documentation',
          prNumber: 3,
          prUrl: 'https://github.com/acme/widget-documentation/pull/3',
        }),
      'docs.pr_state': () => ok({ state: 'open' }),
    };
    // The real `assertReady` runs against a stubbed presence: connected, and
    // advertising `advert` (null = unknown, as from an older runner).
    this.advert = null;
    jest.spyOn(this.presence, 'isConnected').mockReturnValue(true);
    jest
      .spyOn(this.presence, 'commandSupport')
      .mockImplementation((_runner, name) => commandSupport(this.advert, name));
    jest
      .spyOn(this.commands, 'send')
      .mockImplementation(async (_runner, name, args) => {
        this.sent.push({ name, args: args as Record<string, unknown> });
        const handler = this.handlers[name];
        if (!handler) throw new Error(`no handler for ${name}`);
        return handler(args) as never;
      });
    jest
      .spyOn(this.commands, 'sendDocs')
      .mockImplementation(async (runner, name, args) => {
        this.commands.assertReady(runner, name);
        this.sent.push({ name, args: args as Record<string, unknown> });
        const handler = this.handlers[name];
        if (!handler) throw new Error(`no handler for ${name}`);
        return handler(args) as never;
      });
    jest
      .spyOn(this.commands, 'createIssue')
      .mockImplementation(async (_runner, args: IssueCreateArgs) => {
        this.sent.push({ name: 'issue.create', args: { ...args } });
        this.issue += 1;
        return ok<IssueCreateResult>({
          number: this.issue,
          url: `https://github.com/${REPO}/issues/${this.issue}`,
          queued: false,
        });
      });
  }

  sentOf(name: SentCommand['name']): Record<string, unknown>[] {
    return this.sent.filter((c) => c.name === name).map((c) => c.args);
  }

  auditOf(action: string) {
    return this.ctx.prisma.auditRecord.findMany({
      where: { seq: { gt: this.auditFrom }, action },
      orderBy: { seq: 'asc' },
    });
  }

  base(planId?: string): string {
    return `/projects/${this.projectId}/plans${planId ? `/${planId}` : ''}`;
  }

  async createPlan(
    mode: 'batch' | 'dialogue' = 'batch',
    session: Session = this.author,
  ): Promise<PlanDetail> {
    const response = await session.send('post', this.base(), {
      brief: 'Build an exporter\nwith CSV and JSON',
      mode,
    });
    if (response.status !== 201) {
      throw new Error(`create plan → ${response.status} ${response.text}`);
    }
    return response.body as PlanDetail;
  }

  /**
   * #592 (ADR-0055): accepts every pending candidate of an intake as
   * proposed — its stack in its stages, else independent cards.
   */
  async acceptAll(planId: string, session: Session = this.author) {
    const intake = (await this.detail(planId, session)).intake;
    const stack = intake?.candidateStack ?? null;
    return session.send(
      'post',
      `/projects/${this.projectId}/candidates/accept`,
      {
        as: stack ? 'stack' : 'cards',
        candidates: (intake?.candidates ?? [])
          .filter((c) => c.status === 'pending')
          .map((c) => ({
            id: c.id,
            version: c.version,
            ...(stack ? { stage: c.stage } : {}),
          })),
      },
    );
  }

  detail(planId: string, session: Session = this.author) {
    return session.get(this.base(planId)).then((r) => r.body as PlanDetail);
  }

  event(type: string, data: object, root = ROOT): RunnerEvent {
    this.seq += 1;
    return {
      v: 1,
      seq: this.seq,
      ts: new Date().toISOString(),
      type,
      source: 'runner',
      project: { repo: REPO, root },
      data,
    };
  }

  /** The plan's turn that is queued or running. */
  async activeTurn(planId: string) {
    return this.ctx.prisma.planTurn.findFirstOrThrow({
      where: { planId, phase: { in: ['queued', 'running'] } },
    });
  }

  /** The runner reports the active turn finished with `resultText`. */
  async finish(
    planId: string,
    resultText: string,
    extra: { phase?: 'succeeded' | 'failed'; at?: Date } = {},
  ): Promise<void> {
    const turn = await this.activeTurn(planId);
    await this.sinks.dispatch(this.runnerId, [
      this.event('plan_turn.finished', {
        planId,
        turnId: turn.id,
        runId: turn.runId,
        projectId: this.projectId,
        phase: extra.phase ?? 'succeeded',
        at: (extra.at ?? new Date()).toISOString(),
        exitCode: 0,
        resultText,
        resultTruncated: false,
      }),
    ]);
  }
}

/** A batch plan decomposed into `tasks`. */
export const decomposed = async (
  h: PlannerHarness,
  tasks: object[],
): Promise<PlanDetail> => {
  const plan = await h.createPlan('batch');
  await h.finish(
    plan.id,
    block({ action: 'decompose', title: 'Exporter', tasks }),
  );
  return h.detail(plan.id);
};

export const task = (
  key: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  key,
  kind: 'feature',
  title: `Task ${key}`,
  summary: `Summary of ${key}`,
  dependsOn: [],
  questions: [],
  design: { needed: false, why: 'No screen changes.', variants: 1 },
  ...over,
});
