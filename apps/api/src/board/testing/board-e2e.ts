import type {
  CardCommandName,
  IssueCreateArgs,
  RunnerEvent,
} from '@agentdock/shared/protocol';
import { seedProject } from '../../fleet/testing/fleet-e2e';
import { RunnerEventSinks } from '../../runners/runner-event-sinks';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../../test/e2e-app';
import { BoardCommands, type BoardSendResult } from '../board-commands';
import { BoardWork } from '../board-work';

export const ROOT_A = '/srv/dev/widget';
export const ROOT_B = '/srv/dev/gadget';

export type CardHandler = (args: Record<string, unknown>) => unknown;

/** A runner answer: `ok` with an output, or an error code. */
export const ok = <T>(output: T): BoardSendResult<T> => ({
  status: 'ok',
  output,
});
export const failed = (code: 'internal' | 'not_found') =>
  ({ status: 'error', error: { code } }) as const;

/**
 * The board's e2e world: two projects on one runner, a Claude profile, an
 * admin, an operator and a viewer of project A, an operator of B and an
 * outsider. Runner commands never leave the process: `handlers` answer them
 * (a missing handler answers `ok` with a plausible output), and `sent`
 * lists what was sent.
 */
export class BoardWorld {
  ctx!: E2eContext;
  commands!: BoardCommands;
  work!: BoardWork;
  sinks!: RunnerEventSinks;
  runnerId!: string;
  a!: string;
  b!: string;
  admin!: Session;
  operator!: Session;
  viewer!: Session;
  operatorOfB!: Session;
  outsider!: Session;
  operatorId!: string;
  handlers: Partial<Record<CardCommandName | 'issue.create', CardHandler>> = {};
  /** Set to make `assertReady` refuse like an offline runner. */
  offline = false;
  private seq = 0;
  private auditFrom = 0n;

  async init(): Promise<void> {
    this.ctx = await createE2eApp();
    this.commands = this.ctx.app.get(BoardCommands);
    this.work = this.ctx.app.get(BoardWork);
    this.sinks = this.ctx.app.get(RunnerEventSinks);
    const real = this.commands.assertReady.bind(this.commands);
    jest
      .spyOn(this.commands, 'assertReady')
      .mockImplementation((runnerId, name) => {
        if (this.offline) real(runnerId, name);
      });
    jest
      .spyOn(this.commands, 'send')
      .mockImplementation(async (_runner, name, args) =>
        this.answer(name, args as Record<string, unknown>),
      );
    jest
      .spyOn(this.commands, 'createIssue')
      .mockImplementation(async (_runner, args) =>
        this.answer('issue.create', args as unknown as Record<string, unknown>),
      );
  }

  private answer(
    name: CardCommandName | 'issue.create',
    args: Record<string, unknown>,
  ): BoardSendResult<never> {
    const handler = this.handlers[name];
    if (handler) return handler(args) as BoardSendResult<never>;
    const defaults: Record<CardCommandName | 'issue.create', unknown> = {
      'card.run': {
        phase: 'starting',
        tmuxSession: `agentdock-card-${String(args.shortId)}`,
      },
      'card.stop': { stopped: true },
      'card.collect': {
        ahead: 2,
        pushed: true,
        prNumber: 77,
        prUrl: 'https://github.com/acme/widget/pull/77',
      },
      'card.close': {
        stopped: false,
        worktreeRemoved: true,
        branchDeleted: true,
      },
      'card.merge': {
        merged: true,
        alreadyMerged: false,
        method: 'merge',
        mergeCommit: null,
        issueClosed: true,
      },
      'issue.create': {
        number: 41,
        url: 'https://github.com/acme/widget/issues/41',
        queued: false,
      },
    };
    return ok(defaults[name]) as BoardSendResult<never>;
  }

  async reset(): Promise<void> {
    jest.mocked(this.commands.send).mockClear();
    jest.mocked(this.commands.createIssue).mockClear();
    this.handlers = {};
    this.offline = false;
    await resetDatabase(this.ctx.prisma);
    ({ runnerId: this.runnerId, projectId: this.a } = await seedProject(
      this.ctx.prisma,
      ROOT_A,
    ));
    ({ projectId: this.b } = await seedProject(
      this.ctx.prisma,
      ROOT_B,
      this.runnerId,
    ));
    const profile = await this.ctx.prisma.runtimeProfile.create({
      data: {
        runnerId: this.runnerId,
        key: 'claude-main',
        runtime: 'claude',
        label: 'Claude',
        env: {},
        args: [],
        authenticated: true,
      },
    });
    await this.ctx.prisma.project.updateMany({
      data: { defaultProfileId: profile.id },
    });
    await createUser(this.ctx.prisma, 'admin@x.test', 'admin');
    this.admin = await login(this.ctx, 'admin@x.test');
    this.operator = await this.member('op@x.test', this.a, 'operator');
    this.operatorId = (
      await this.ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'op@x.test' },
      })
    ).id;
    this.viewer = await this.member('viewer@x.test', this.a, 'viewer');
    this.operatorOfB = await this.member('op-b@x.test', this.b, 'operator');
    this.outsider = await this.member('out@x.test', null, 'operator');
    const last = await this.ctx.prisma.auditRecord.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    this.auditFrom = last?.seq ?? 0n;
  }

  private async member(
    email: string,
    projectId: string | null,
    role: 'viewer' | 'operator',
  ): Promise<Session> {
    const user = await createUser(this.ctx.prisma, email, role);
    if (projectId) {
      await this.ctx.prisma.projectMember.create({
        data: { projectId, userId: user.id },
      });
    }
    return login(this.ctx, email);
  }

  async close(): Promise<void> {
    await this.work.settled();
    await this.ctx.app.close();
  }

  /** The commands sent of `name`, oldest first. */
  sent(name: CardCommandName): Record<string, unknown>[] {
    return jest
      .mocked(this.commands.send)
      .mock.calls.filter(([, n]) => n === name)
      .map(([, , args]) => args as Record<string, unknown>);
  }

  issues(): IssueCreateArgs[] {
    return jest
      .mocked(this.commands.createIssue)
      .mock.calls.map(([, args]) => args);
  }

  /** Audit records of `action` written by this test. */
  audit(action: string) {
    return this.ctx.prisma.auditRecord.findMany({
      where: { seq: { gt: this.auditFrom }, action },
      orderBy: { seq: 'asc' },
    });
  }

  path(projectId = this.a): string {
    return `/projects/${projectId}`;
  }

  async createCard(
    body: Record<string, unknown> = {},
    session = this.operator,
    projectId = this.a,
  ): Promise<{ id: string; number: number }> {
    const response = await session.send(
      'post',
      `${this.path(projectId)}/board/cards`,
      { title: 'Add login', body: 'Users sign in.', ...body },
    );
    expect(response.status).toBe(201);
    return response.body as { id: string; number: number };
  }

  async runCard(number: number, body: object = {}) {
    return this.operator.send(
      'post',
      `${this.path()}/board/cards/${number}/run`,
      body,
    );
  }

  /** Delivers runner events to the sinks, as ingest does. */
  async deliver(
    type: string,
    data: object,
    extra: Partial<RunnerEvent> = {},
  ): Promise<void> {
    this.seq += 1;
    const event: RunnerEvent = {
      v: 1,
      seq: this.seq,
      ts: new Date(Date.UTC(2026, 9, 14, 12, 0, this.seq)).toISOString(),
      type,
      source: 'runner',
      project: { repo: 'acme/widget', root: ROOT_A },
      data,
      ...extra,
    };
    await this.sinks.dispatch(this.runnerId, [event]);
  }

  /** A `hook.*` event of a Claude session. */
  hook(type: string, sessionId: string, data: object = {}): Promise<void> {
    return this.deliver(type, data, {
      source: 'hook',
      session: { runtime: 'claude', id: sessionId },
    });
  }

  card(number: number, projectId = this.a) {
    return this.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { projectId_number: { projectId, number } },
      include: { rounds: { orderBy: { round: 'asc' } } },
    });
  }
}
