import { BOARD_ERROR } from '@agentdock/shared';
import type {
  CardCommandName,
  IssueCreateArgs,
  RunnerEvent,
} from '@agentdock/shared/protocol';
import { seedProject } from '../../fleet/testing/fleet-e2e';
import { RunnerConnectHooks } from '../../runners/runner-connect-hooks';
import { RunnerEventSinks } from '../../runners/runner-event-sinks';
import { capabilities } from '../../runners/testing/runner-e2e';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../../test/e2e-app';
import { BoardCommands, type BoardSendResult } from '../board-commands';
import { BoardFailure } from '../board-error';
import { BoardWork } from '../board-work';
import { CollectRetryTimer } from '../collect-retry-timer';

export const ROOT_A = '/srv/dev/widget';
export const ROOT_B = '/srv/dev/gadget';

export type CardHandler = (args: Record<string, unknown>) => unknown;

type WorldCommand =
  | CardCommandName
  | 'card.checks'
  | 'card.ciRetrigger'
  | 'card.prClose'
  | 'issue.create'
  | 'pr.inspect'
  | 'docs.publish_specs';

/** #329 D4: a retry the board scheduled, captured instead of a real timer. */
export interface ScheduledRetry {
  cardId: string;
  delayMs: number;
  run: () => void;
}

/** 40 hex: the head `pr.inspect` answers with by default. */
export const HEAD_SHA = 'a'.repeat(40);

/** A `pr.inspect` answer for PR #77 of the world's repository. */
export const prInspection = (extra: Record<string, unknown> = {}) => ({
  number: 77,
  url: 'https://github.com/acme/widget/pull/77',
  title: 'C-1 Add login',
  body: 'Closes #41',
  state: 'open',
  headSha: HEAD_SHA,
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  files: [],
  filesTruncated: false,
  checks: 'pass',
  checkList: [],
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  fetchedAt: '2026-10-15T12:00:00.000Z',
  ...extra,
});

/** #359 D5: a `card.checks` answer — PR open at `HEAD_SHA`, one passing check. */
export const cardChecks = (extra: Record<string, unknown> = {}) => ({
  state: 'open',
  headSha: HEAD_SHA,
  mergeable: 'MERGEABLE',
  checks: [{ name: 'ci/check', bucket: 'pass', link: 'https://ci.example/1' }],
  ...extra,
});

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
  handlers: Partial<Record<WorldCommand, CardHandler>> = {};
  /** Set to make `assertReady` refuse like an offline runner. */
  offline = false;
  /** #379: commands the runner does not serve — `assertReady` refuses them. */
  unserved = new Set<string>();
  /** #329 D9: whether the runner advertises `card.prClose`. */
  prCloseAdvertised = true;
  /**
   * #359: whether the runner advertises `card.checks` — a card then ships
   * itself. Off by default: the suites before #359 run as they did.
   */
  checksServed = false;
  /** #484: whether the runner advertises `card.ciRetrigger`. */
  ciRetriggerServed = true;
  /** #329 D4: the delayed collect retries scheduled so far, oldest first. */
  retries: ScheduledRetry[] = [];
  connectHooks!: RunnerConnectHooks;
  private seq = 0;
  private auditFrom = 0n;

  /** `create` builds the app; #578's Telegram suite passes its own. */
  async init(create: () => Promise<E2eContext> = createE2eApp): Promise<void> {
    this.ctx = await create();
    this.commands = this.ctx.app.get(BoardCommands);
    this.work = this.ctx.app.get(BoardWork);
    this.sinks = this.ctx.app.get(RunnerEventSinks);
    const real = this.commands.assertReady.bind(this.commands);
    jest
      .spyOn(this.commands, 'assertReady')
      .mockImplementation((runnerId, name) => {
        if (this.offline) real(runnerId, name);
        if (this.unserved.has(name)) {
          throw new BoardFailure(
            503,
            BOARD_ERROR.commandUnavailable,
            `The runner does not serve ${name}; update it`,
          );
        }
      });
    jest
      .spyOn(this.commands, 'publishDocsSpecs')
      .mockImplementation(async (runnerId, args) => {
        this.commands.assertReady(runnerId, 'docs.publish_specs');
        return this.answer('docs.publish_specs', { ...args });
      });
    jest
      .spyOn(this.commands, 'send')
      .mockImplementation(async (_runner, name, args) =>
        this.answer(name, args as Record<string, unknown>),
      );
    jest
      .spyOn(this.commands, 'closePr')
      .mockImplementation(async (runnerId, args) => {
        this.commands.assertReady(runnerId, 'card.prClose');
        return this.answer('card.prClose', { ...args });
      });
    jest
      .spyOn(this.commands, 'advertisesPrClose')
      .mockImplementation(() => this.prCloseAdvertised);
    jest
      .spyOn(this.commands, 'servesChecks')
      .mockImplementation(() => this.checksServed);
    jest
      .spyOn(this.commands, 'checks')
      .mockImplementation(async (runnerId, args) => {
        this.commands.assertReady(runnerId, 'card.checks');
        return this.answer('card.checks', { ...args });
      });
    jest
      .spyOn(this.commands, 'servesCiRetrigger')
      .mockImplementation(() => this.ciRetriggerServed);
    jest
      .spyOn(this.commands, 'ciRetrigger')
      .mockImplementation(async (runnerId, args) => {
        this.commands.assertReady(runnerId, 'card.ciRetrigger');
        return this.answer('card.ciRetrigger', { ...args });
      });
    this.connectHooks = this.ctx.app.get(RunnerConnectHooks);
    const timer = this.ctx.app.get(CollectRetryTimer);
    jest.spyOn(timer, 'schedule').mockImplementation((cardId, delayMs, run) => {
      this.retries.push({ cardId, delayMs, run });
    });
    jest
      .spyOn(this.commands, 'createIssue')
      .mockImplementation(async (_runner, args) =>
        this.answer('issue.create', args as unknown as Record<string, unknown>),
      );
    jest
      .spyOn(this.commands, 'inspectPr')
      .mockImplementation(async (runnerId, args) => {
        this.commands.assertReady(runnerId, 'pr.inspect');
        return this.answer('pr.inspect', { ...args });
      });
  }

  private answer(
    name: WorldCommand,
    args: Record<string, unknown>,
  ): BoardSendResult<never> {
    const handler = this.handlers[name];
    if (handler) return handler(args) as BoardSendResult<never>;
    const defaults: Record<WorldCommand, unknown> = {
      'pr.inspect': prInspection(),
      'card.checks': cardChecks(),
      'card.ciRetrigger': { retriggered: true },
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
      'card.prClose': {
        closed: true,
        alreadyClosed: false,
        branchDeleted: Boolean(args.deleteBranch),
        issueClosed: args.issue !== null && args.issue !== undefined,
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
        // What the result schema's default makes of an older runner's answer.
        branchDeleted: false,
      },
      'issue.create': {
        number: 41,
        url: 'https://github.com/acme/widget/issues/41',
        queued: false,
      },
      'docs.publish_specs': {
        repo: 'acme/widget-documentation',
        prNumber: 5,
        prUrl: 'https://github.com/acme/widget-documentation/pull/5',
      },
    };
    return ok(defaults[name]) as BoardSendResult<never>;
  }

  async reset(): Promise<void> {
    jest.mocked(this.commands.send).mockClear();
    jest.mocked(this.commands.createIssue).mockClear();
    jest.mocked(this.commands.inspectPr).mockClear();
    jest.mocked(this.commands.closePr).mockClear();
    jest.mocked(this.commands.publishDocsSpecs).mockClear();
    jest.mocked(this.commands.checks).mockClear();
    jest.mocked(this.commands.ciRetrigger).mockClear();
    this.handlers = {};
    this.offline = false;
    this.unserved = new Set();
    this.prCloseAdvertised = true;
    this.checksServed = false;
    this.ciRetriggerServed = true;
    this.retries = [];
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

  /** #379: the `docs.publish_specs` commands sent, oldest first. */
  docsSpecs(): Record<string, unknown>[] {
    return jest
      .mocked(this.commands.publishDocsSpecs)
      .mock.calls.map(([, args]) => args as unknown as Record<string, unknown>);
  }

  /** #484: the `card.ciRetrigger` commands sent, oldest first. */
  ciRetriggers(): Record<string, unknown>[] {
    return jest
      .mocked(this.commands.ciRetrigger)
      .mock.calls.map(([, args]) => args as unknown as Record<string, unknown>);
  }

  /** #329 D8: the `card.prClose` commands sent, oldest first. */
  prCloses(): Record<string, unknown>[] {
    return jest
      .mocked(this.commands.closePr)
      .mock.calls.map(([, args]) => ({ ...args }));
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

  /**
   * #445: the runner advertises `tokenSaver` in its capabilities; without a
   * call it stores none, as a runner older than the feature.
   */
  async advertiseTokenSaver(tokenSaver = true): Promise<void> {
    await this.ctx.prisma.runner.update({
      where: { id: this.runnerId },
      data: { capabilities: { ...capabilities, tokenSaver } },
    });
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
