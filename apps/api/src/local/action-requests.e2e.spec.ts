import type { ActionRequestKind } from '@agentdock/shared';
import type { CommandName, PrInspection } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import { ApprovalCommands } from '../approvals/approval-commands';
import { Feed } from '../budgets/testing/budgets-e2e';
import { seedProject } from '../fleet/testing/fleet-e2e';
import { seedPrices } from '../prices/seed-prices';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { TelegramActionRequestService } from '../telegram/telegram-action-request.service';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { ingest, resetUsage } from '../usage/testing/usage-e2e';
import { ActionRequestExpiryJob } from './action-request-expiry.job';
import type { ActionRequestView } from './action-request-mapper';
import { ActionRequestsService } from './action-requests.service';

const ROOT = '/srv/dev/widget';
const RUNNER_ACTOR = (runnerId: string) => ({
  actor: { type: 'runner' as const, runnerId },
});

const OUTPUTS: Partial<Record<CommandName, unknown>> = {
  'orchestrator.start': {
    session: 'agentdock-orch-acme-widget',
    startedAt: '2026-10-09T10:00:00.000Z',
  },
  'orchestrator.stop': { stopped: true },
};

const PR = 51;
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

const inspection = (headSha: string): PrInspection => ({
  number: PR,
  url: `https://github.com/acme/widget/pull/${PR}`,
  title: 'feat: harmless',
  body: '',
  state: 'open',
  headSha,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  files: [],
  filesTruncated: false,
  checks: 'green',
  checkList: [],
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  fetchedAt: '2026-10-17T10:00:00.000Z',
});

/**
 * Spec 201 D18, acceptance criteria 6 and 7 (API and Telegram half): who may
 * decide an action request, that an approval executes as the approver — the
 * budget gate and the audit log see them — and the Telegram buttons.
 */
describe('action requests (e2e)', () => {
  let ctx: E2eContext;
  let requests: ActionRequestsService;
  let telegram: TelegramActionRequestService;
  let runnerId: string;
  let projectId: string;
  let admin: Session;
  let adminId: string;
  let requester: Session;
  let requesterId: string;
  let approver: Session;
  let approverId: string;
  let viewer: Session;
  let viewerId: string;
  let outsider: Session;
  let sent: { name: CommandName; args: Record<string, unknown> }[];

  const memberOf = async (
    email: string,
    role: 'viewer' | 'operator',
    member = true,
  ) => {
    const user = await createUser(ctx.prisma, email, role);
    if (member) {
      await ctx.prisma.projectMember.create({
        data: { projectId, userId: user.id },
      });
    }
    return { session: await login(ctx, email), id: user.id };
  };

  const create = (
    kind: ActionRequestKind,
    args: Record<string, unknown>,
    requestedById = requesterId,
  ) =>
    requests.create(
      {
        projectId,
        runnerId,
        sessionId: null,
        requestedById,
        requesterRole: 'operator',
        kind,
        args,
        summary: `Please ${kind}`,
      },
      { ctx: RUNNER_ACTOR(runnerId), meta: { onBehalfOf: requestedById } },
    );

  const decide = (
    session: Session,
    id: string,
    decision: 'approve' | 'deny',
    body: object = {},
  ) =>
    session.send(
      'post',
      `/projects/${projectId}/action-requests/${id}/${decision}`,
      body,
    );

  const audits = (action: string) =>
    ctx.prisma.auditRecord.findMany({
      where: { action, projectId },
      orderBy: { seq: 'asc' },
    });

  beforeAll(async () => {
    ctx = await createE2eApp();
    requests = ctx.app.get(ActionRequestsService);
    telegram = ctx.app.get(TelegramActionRequestService);
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetUsage(ctx.prisma);
    await seedPrices(ctx.prisma);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    ({ runnerId, projectId } = await seedProject(ctx.prisma, ROOT));
    const profile = await ctx.prisma.runtimeProfile.create({
      data: {
        runnerId,
        key: 'claude-main',
        runtime: 'claude',
        label: 'Claude',
        env: {},
        args: [],
        authenticated: true,
      },
    });
    await ctx.prisma.project.update({
      where: { id: projectId },
      data: { defaultProfileId: profile.id },
    });
    adminId = (await createUser(ctx.prisma, 'admin@example.com', 'admin')).id;
    admin = await login(ctx, 'admin@example.com');
    ({ session: requester, id: requesterId } = await memberOf(
      'requester@example.com',
      'operator',
    ));
    ({ session: approver, id: approverId } = await memberOf(
      'approver@example.com',
      'operator',
    ));
    ({ session: viewer, id: viewerId } = await memberOf(
      'viewer@example.com',
      'viewer',
    ));
    ({ session: outsider } = await memberOf(
      'outsider@example.com',
      'operator',
      false,
    ));

    sent = [];
    jest
      .spyOn(ctx.app.get(RunnerPresence), 'isConnected')
      .mockReturnValue(true);
    jest
      .spyOn(ctx.app.get(RunnerCommandService), 'send')
      .mockImplementation(async (_runner, name, args) => {
        sent.push({ name, args: args as Record<string, unknown> });
        const output = OUTPUTS[name];
        return output === undefined
          ? { status: 'error', error: { code: 'unknown_command' } }
          : ({ status: 'ok', output, rttMs: 1 } as never);
      });
  });
  afterEach(() => jest.restoreAllMocks());

  describe('authorization (criterion 6)', () => {
    it('lists to any member, hides the project from a non-member, and refuses a viewer a decision', async () => {
      const request = await create('orchestrator_start', { mode: 'start' });
      const list = await viewer.get(
        `/projects/${projectId}/action-requests?status=pending`,
      );
      expect(list.status).toBe(200);
      expect((list.body as ActionRequestView[]).map((r) => r.id)).toEqual([
        request.id,
      ]);
      const toolUse = await create('tool_use', {
        toolName: 'Bash',
        input: 'ls -la',
      });
      const all = await viewer.get(`/projects/${projectId}/action-requests`);
      expect(
        (all.body as ActionRequestView[]).find((r) => r.id === toolUse.id)?.args
          .input,
      ).toBe('ls -la');

      expect((await decide(viewer, request.id, 'approve')).status).toBe(403);
      expect((await decide(viewer, request.id, 'deny')).status).toBe(403);
      expect((await decide(outsider, request.id, 'approve')).status).toBe(404);
      expect(
        (await outsider.get(`/projects/${projectId}/action-requests`)).status,
      ).toBe(404);
      expect(
        (
          await ctx.prisma.actionRequest.findUniqueOrThrow({
            where: { id: request.id },
          })
        ).status,
      ).toBe('pending');
      expect(sent).toEqual([]);
    });

    it('refuses the requester their own orchestrator start, and audits it', async () => {
      const request = await create('orchestrator_start', { mode: 'start' });
      const response = await decide(requester, request.id, 'approve');
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('self_approval');
      expect(sent).toEqual([]);
      const [denied] = await audits('action_request.decided');
      expect(denied).toMatchObject({
        actorUserId: requesterId,
        result: 'denied',
        meta: { reason: 'self_approval', via: 'web' },
      });
      // Denying their own request is allowed.
      expect((await decide(requester, request.id, 'deny')).status).toBe(200);
    });

    it('lets an admin approve their own request', async () => {
      const request = await create('orchestrator_stop', {}, adminId);
      const response = await decide(admin, request.id, 'approve');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('executed');
      expect(sent.map((s) => s.name)).toEqual(['orchestrator.stop']);
    });

    it('lets the requester approve their own tool use', async () => {
      const request = await create('tool_use', { toolName: 'Bash' });
      const response = await decide(requester, request.id, 'approve');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('approved');
      expect(sent).toEqual([]);
    });
  });

  describe('execution as the approver (criterion 6)', () => {
    it('starts the orchestrator as the approver', async () => {
      const request = await create('orchestrator_start', { mode: 'next' });
      const response = await decide(approver, request.id, 'approve', {
        note: 'go',
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: request.id,
        status: 'executed',
        decidedById: approverId,
        note: 'go',
        result: { status: 'ok' },
      });
      expect(sent.map((s) => [s.name, s.args.mode])).toEqual([
        ['orchestrator.start', 'next'],
      ]);
      const [start] = await audits('orchestrator.start');
      expect(start).toMatchObject({
        actorType: 'user',
        actorUserId: approverId,
        result: 'ok',
      });
      const [run] = await ctx.prisma.commandRun.findMany({
        where: { projectId },
      });
      expect(run.userId).toBe(approverId);
      expect(
        (await audits('action_request.executed')).map((a) => [
          a.actorUserId,
          a.result,
        ]),
      ).toEqual([[approverId, 'ok']]);
      expect(
        (await audits('action_request.created')).map((a) => [
          a.actorType,
          a.actorRunnerId,
        ]),
      ).toEqual([['runner', runnerId]]);
    });

    it('fails the approval when a hard-stop budget is exceeded, sending nothing', async () => {
      const feed = new Feed();
      const now = Date.now();
      await ingest(ctx, runnerId, [
        feed.session(
          'w-1',
          `${ROOT}-wt/i1`,
          new Date(now - 60_000).toISOString(),
          {
            projectId,
            slot: 'i1',
          },
        ),
        feed.spend('w-1', 'r-1', new Date(now - 30_000).toISOString()),
      ]);
      const budget = await admin.send(
        'post',
        `/projects/${projectId}/budgets`,
        { period: 'day', limitUsd: '1', action: 'stop', timezone: 'UTC' },
      );
      expect(budget.status).toBe(201);

      const request = await create('orchestrator_start', { mode: 'start' });
      const response = await decide(approver, request.id, 'approve');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'failed',
        decidedById: approverId,
        result: { error: 'budget_exceeded' },
      });
      expect(sent).toEqual([]);
      expect(
        (await audits('action_request.executed')).map((a) => [
          a.actorUserId,
          a.result,
        ]),
      ).toEqual([[approverId, 'error']]);
    });

    it('records a denial with its note and executes nothing', async () => {
      const request = await create('tool_use', { toolName: 'Bash' });
      const response = await decide(approver, request.id, 'deny', {
        note: 'not on main',
      });
      expect(response.body).toMatchObject({
        status: 'denied',
        note: 'not on main',
      });
      expect((await decide(approver, request.id, 'approve')).status).toBe(409);
      expect((await requests.status(projectId, request.id)).status).toBe(
        'denied',
      );
    });

    it("a viewer's list changes no rows and shows a due request as expired", async () => {
      const request = await create('orchestrator_start', { mode: 'start' });
      await ctx.prisma.actionRequest.update({
        where: { id: request.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      const before = await ctx.prisma.actionRequest.findMany({
        orderBy: { id: 'asc' },
      });
      const base = `/projects/${projectId}/action-requests`;
      const seen = async (query: string) =>
        ((await viewer.get(`${base}${query}`)).body as ActionRequestView[])
          .filter((r) => r.id === request.id)
          .map((r) => r.status);
      expect(await seen('')).toEqual(['expired']);
      expect(await seen('?status=pending')).toEqual([]);
      expect(await seen('?status=expired')).toEqual(['expired']);
      expect((await requests.status(projectId, request.id)).status).toBe(
        'expired',
      );

      const after = await ctx.prisma.actionRequest.findMany({
        orderBy: { id: 'asc' },
      });
      expect(after).toEqual(before);
      expect(after.find((r) => r.id === request.id)?.status).toBe('pending');
      expect(await ctx.app.get(ActionRequestExpiryJob).sweep()).toBe(1);
    });

    it('expires pending requests past their deadline', async () => {
      const request = await create('tool_use', { toolName: 'Bash' });
      expect(
        new Date(request.expiresAt).getTime() - Date.now(),
      ).toBeGreaterThan(4 * 60_000);
      await ctx.prisma.actionRequest.update({
        where: { id: request.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      expect(await ctx.app.get(ActionRequestExpiryJob).sweep()).toBe(1);
      const response = await decide(approver, request.id, 'approve');
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('not_pending');
    });

    describe('pr_approve (C-110)', () => {
      let head: string;
      let approve: jest.SpyInstance;

      beforeEach(async () => {
        await ctx.prisma.mergeApproval.create({
          data: {
            projectId,
            prNumber: PR,
            slot: 'i42-api',
            issue: 42,
            source: 'orchestrator',
            status: 'waiting',
            waitingSince: new Date(),
          },
        });
        head = H1;
        const commands = ctx.app.get(ApprovalCommands);
        jest
          .spyOn(commands, 'inspect')
          .mockImplementation(async () => inspection(head));
        approve = jest
          .spyOn(commands, 'approve')
          .mockResolvedValue({ written: true });
      });

      it('binds the request to the head read at creation', async () => {
        const request = await create('pr_approve', { pr: PR });
        expect(request.args).toEqual({
          pr: PR,
          headSha: H1,
          title: 'feat: harmless',
          url: `https://github.com/acme/widget/pull/${PR}`,
        });
        const [notification] = await ctx.prisma.notification.findMany({
          where: { kind: 'action.requested' },
        });
        expect(notification.title).toBe(
          `A session asks to approve PR #${PR} at aaaaaaa`,
        );
        expect(notification.body).toContain('feat: harmless');
        expect(notification.body).toContain(
          `https://github.com/acme/widget/pull/${PR}/files/${H1}`,
        );

        const response = await decide(approver, request.id, 'approve');
        expect(response.body).toMatchObject({
          status: 'executed',
          result: { pr: PR, headSha: H1 },
          pr: { headSha: H1, title: 'feat: harmless' },
        });
        expect(approve).toHaveBeenCalledWith(
          runnerId,
          expect.objectContaining({ pr: PR, headSha: H1 }),
          expect.anything(),
        );
      });

      it('fails with head_moved when the head moved before the approval, approving nothing', async () => {
        const request = await create('pr_approve', { pr: PR });
        head = H2;
        const response = await decide(approver, request.id, 'approve');
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          status: 'failed',
          decidedById: approverId,
          result: { error: 'head_moved' },
        });
        expect(approve).not.toHaveBeenCalled();
        expect(
          await ctx.prisma.mergeApproval.count({
            where: { projectId, status: 'approved' },
          }),
        ).toBe(0);
      });

      it('refuses a head the session supplies itself', async () => {
        await expect(
          create('pr_approve', { pr: PR, headSha: H2 }),
        ).rejects.toMatchObject({ status: 400 });
      });

      it('fails a request stored without a head', async () => {
        const request = await create('pr_approve', { pr: PR });
        await ctx.prisma.actionRequest.update({
          where: { id: request.id },
          data: { args: { pr: PR } },
        });
        const response = await decide(approver, request.id, 'approve');
        expect(response.body).toMatchObject({
          status: 'failed',
          result: { error: 'invalid_args' },
        });
        expect(approve).not.toHaveBeenCalled();
      });
    });

    it('refuses args a kind does not take', async () => {
      await expect(
        create('orchestrator_stop', { force: true }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await ctx.prisma.actionRequest.count()).toBe(0);
    });
  });

  describe('notifications and Telegram (criterion 7)', () => {
    const CHAT = 4242;
    const press = (data: string, chatId = CHAT) =>
      telegram.handleCallback({
        id: 'cb-1',
        from: { id: chatId },
        message: { message_id: 1, chat: { id: chatId, type: 'private' } },
        data,
      });

    const notificationOf = (userId: string) =>
      ctx.prisma.notification.findFirstOrThrow({
        where: { userId, kind: 'action.requested' },
      });

    it('notifies the operators and admins, not the viewers', async () => {
      await create('orchestrator_start', { mode: 'start' });
      const rows = await ctx.prisma.notification.findMany({
        where: { kind: 'action.requested' },
        select: { userId: true },
      });
      expect(rows.map((r) => r.userId).sort()).toEqual(
        [adminId, requesterId, approverId].sort(),
      );
      expect(rows.some((r) => r.userId === viewerId)).toBe(false);
    });

    it('approves from a linked operator chat, as that operator', async () => {
      await ctx.prisma.telegramLink.create({
        data: { userId: approverId, chatId: BigInt(CHAT) },
      });
      const request = await create('orchestrator_start', { mode: 'start' });
      const notification = await notificationOf(approverId);

      const offer = await telegram.offer(notification.id);
      const data = `x:${notification.id}:${request.id}`;
      expect(offer).toEqual({
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: data },
            {
              text: 'Deny',
              callback_data: `y:${notification.id}:${request.id}`,
            },
          ],
        ],
      });
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);

      const answer = await press(data);
      expect(answer.text).toBe('Approved and carried out.');
      expect(sent.map((s) => s.name)).toEqual(['orchestrator.start']);
      const [decided] = await audits('action_request.decided');
      expect(decided).toMatchObject({
        actorUserId: approverId,
        result: 'ok',
        meta: { via: 'telegram' },
      });
      // Decided: the buttons are not offered again.
      expect(await telegram.offer(notification.id)).toBeNull();
    });

    it('refuses an unlinked chat and audits it', async () => {
      const request = await create('tool_use', { toolName: 'Bash' });
      const notification = await notificationOf(approverId);
      const answer = await press(`x:${notification.id}:${request.id}`, 999);
      expect(answer.text).toBe('This chat is not linked to AgentDock.');
      const records = await ctx.prisma.auditRecord.findMany({
        where: { action: 'action_request.decided', targetId: request.id },
      });
      expect(records).toEqual([
        expect.objectContaining({
          actorType: 'anonymous',
          result: 'denied',
          meta: expect.objectContaining({
            via: 'telegram',
            reason: 'not_linked',
          }),
        }),
      ]);
      expect((await requests.status(projectId, request.id)).status).toBe(
        'pending',
      );
    });

    it("refuses a viewer's chat, and a press on someone else's message", async () => {
      await ctx.prisma.telegramLink.create({
        data: { userId: viewerId, chatId: BigInt(CHAT) },
      });
      const request = await create('tool_use', { toolName: 'Bash' });
      const theirs = await notificationOf(approverId);
      expect((await press(`x:${theirs.id}:${request.id}`)).text).toBe(
        'This message is not one AgentDock can act on any more. Decide in AgentDock.',
      );
      // Viewers get no notification; give them one to press.
      const own = await ctx.prisma.notification.create({
        data: {
          userId: viewerId,
          kind: 'action.requested',
          projectId,
          title: 't',
          body: 'b',
          link: theirs.link,
          firstAt: new Date(),
          lastAt: new Date(),
        },
      });
      expect((await press(`x:${own.id}:${request.id}`)).text).toBe(
        'Only an operator or an admin of this project can decide this request.',
      );
      expect((await requests.status(projectId, request.id)).status).toBe(
        'pending',
      );
    });

    it('denies from Telegram', async () => {
      await ctx.prisma.telegramLink.create({
        data: { userId: requesterId, chatId: BigInt(CHAT) },
      });
      const request = await create('orchestrator_start', { mode: 'start' });
      const notification = await notificationOf(requesterId);
      // Their own request: approving is refused, denying is not.
      expect((await press(`x:${notification.id}:${request.id}`)).text).toBe(
        'You cannot approve your own request. Another operator or an admin has to.',
      );
      expect((await press(`y:${notification.id}:${request.id}`)).text).toBe(
        'Denied.',
      );
      expect(sent).toEqual([]);
    });
  });
});
