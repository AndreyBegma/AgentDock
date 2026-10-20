import type { Role } from '@nautelle/shared';
import type {
  LocalRequestMessage,
  LocalResponseMessage,
} from '@nautelle/shared/protocol';
import { localResponseMessageSchema } from '@nautelle/shared/protocol';
import { HttpException } from '@nestjs/common';
import type { AuditService } from '../audit/audit.service';
import type { AuditEntry } from '../audit/audit.types';
import type { PrismaService } from '../database/prisma.service';
import type { ProjectAccessService } from '../projects';
import { RunnerLocalRequests } from '../runners/runner-local-requests';
import type { LocalCall } from './local-call';
import type { LocalHandlers } from './local-handlers';
import { capLocalRole, LocalRequestRouter } from './local-request-router';

const RUNNER = 'rn_1';
const PROJECT = 'prj_a';

const project = {
  id: PROJECT,
  runnerId: RUNNER,
  rootPath: '/srv/dev/widget',
  repo: 'acme/widget',
  displayName: 'widget',
  baseBranch: 'develop',
  baseOverride: null,
};

interface Setup {
  localUser?: { id: string; email: string; role: Role; status: string } | null;
  projectRow?: typeof project | null;
  /** The user's effective role on the project; null: not a member. */
  access?: Role | null;
}

const setup = (options: Setup = {}) => {
  const audits: AuditEntry[] = [];
  const calls: { method: string; call: LocalCall }[] = [];
  const localUser =
    options.localUser === undefined
      ? {
          id: 'u_1',
          email: 'me@example.com',
          role: 'operator',
          status: 'active',
        }
      : options.localUser;
  const prisma = {
    runner: {
      findUnique: jest.fn(async () => ({ localUser })),
    },
    project: {
      findUnique: jest.fn(async () =>
        options.projectRow === undefined ? project : options.projectRow,
      ),
    },
  } as unknown as PrismaService;
  const access = {
    resolve: jest.fn(async () => {
      const role = options.access === undefined ? 'operator' : options.access;
      return role ? { projectId: PROJECT, role } : null;
    }),
  } as unknown as ProjectAccessService;
  const audit = {
    record: jest.fn(async (entry: AuditEntry) => {
      audits.push(entry);
    }),
  } as unknown as AuditService;
  const handle =
    (method: string, result: unknown) =>
    async (_args: unknown, call: LocalCall) => {
      calls.push({ method, call });
      return result;
    };
  const handlers = {
    table: {
      'fleet.status': handle('fleet.status', {
        orchestrator: { present: false, state: null },
        slots: [],
      }),
      'issue.create': handle('issue.create', {
        number: 7,
        url: 'https://github.com/acme/widget/issues/7',
        queued: false,
      }),
      'away.set': handle('away.set', { awayMode: true }),
      'activity.note': async () => {
        throw new HttpException(
          { statusCode: 409, error: 'budget_exceeded', message: 'over' },
          409,
        );
      },
      'queue.list': handle('queue.list', { items: [{ number: -1 }] }),
    },
  } as unknown as LocalHandlers;
  const registry = new RunnerLocalRequests();
  const router = new LocalRequestRouter(
    prisma,
    access,
    audit,
    handlers,
    registry,
  );
  router.onModuleInit();
  return { router, registry, audits, calls };
};

const request = (
  method: string,
  args: unknown = {},
  extra: Partial<LocalRequestMessage> = {},
): LocalRequestMessage => ({
  type: 'local.request',
  id: 'lr_1',
  method,
  args,
  projectId: PROJECT,
  via: 'mcp',
  ...extra,
});

const errorOf = (response: LocalResponseMessage) => {
  expect(localResponseMessageSchema.safeParse(response).success).toBe(true);
  expect(response.ok).toBe(false);
  return response.error?.code;
};

describe('LocalRequestRouter (spec 201 D6–D8)', () => {
  it('caps every role at operator', () => {
    expect(capLocalRole('admin')).toBe('operator');
    expect(capLocalRole('operator')).toBe('operator');
    expect(capLocalRole('viewer')).toBe('viewer');
  });

  it('answers an unknown method `unknown_method` and audits it denied', async () => {
    const { registry, audits, calls } = setup();
    const response = await registry.answer(RUNNER, request('fleet.nuke'));
    expect(errorOf(response)).toBe('unknown_method');
    expect(calls).toEqual([]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: { type: 'runner', runnerId: RUNNER },
      action: 'local.request',
      result: 'denied',
      meta: { reason: 'unknown_method', via: 'mcp' },
    });
  });

  it('answers extra args `invalid_args` and audits it denied', async () => {
    const { registry, audits, calls } = setup();
    const response = await registry.answer(
      RUNNER,
      request('fleet.status', { path: '/etc' }),
    );
    expect(errorOf(response)).toBe('invalid_args');
    expect(calls).toEqual([]);
    expect(audits[0]).toMatchObject({ result: 'denied' });
  });

  it('refuses every request of a runner without a local user', async () => {
    const { registry, audits } = setup({ localUser: null });
    const response = await registry.answer(RUNNER, request('fleet.status'));
    expect(errorOf(response)).toBe('forbidden');
    expect(audits[0]).toMatchObject({ result: 'denied' });
  });

  it('refuses a local user who is not a member, audited on behalf of them', async () => {
    const { registry, audits, calls } = setup({ access: null });
    const response = await registry.answer(RUNNER, request('fleet.status'));
    expect(errorOf(response)).toBe('forbidden');
    expect(calls).toEqual([]);
    expect(audits[0]).toMatchObject({
      action: 'local.request',
      result: 'denied',
      projectId: PROJECT,
      meta: { reason: 'forbidden', onBehalfOf: 'u_1', via: 'mcp' },
    });
  });

  it('refuses a viewer a write with `forbidden`', async () => {
    const { registry, calls } = setup({ access: 'viewer' });
    const response = await registry.answer(
      RUNNER,
      request('issue.create', { title: 'x', body: 'y', queue: false }),
    );
    expect(errorOf(response)).toBe('forbidden');
    expect(calls).toEqual([]);
  });

  it('lets a viewer read', async () => {
    const { registry, calls } = setup({ access: 'viewer' });
    const response = await registry.answer(RUNNER, request('fleet.status'));
    expect(response.ok).toBe(true);
    expect(calls[0].call.role).toBe('viewer');
  });

  it('acts as an admin local user with operator only, and audits the write as the runner', async () => {
    const { registry, audits, calls } = setup({ access: 'admin' });
    const response = await registry.answer(
      RUNNER,
      request('issue.create', { title: 'x', body: 'y', queue: false }),
    );
    expect(response).toEqual({
      type: 'local.response',
      id: 'lr_1',
      ok: true,
      data: {
        number: 7,
        url: 'https://github.com/acme/widget/issues/7',
        queued: false,
      },
    });
    expect(calls[0].call.role).toBe('operator');
    expect(calls[0].call.ctx.actor).toEqual({
      type: 'runner',
      runnerId: RUNNER,
    });
    expect(audits).toEqual([
      expect.objectContaining({
        actor: { type: 'runner', runnerId: RUNNER },
        action: 'local.request',
        result: 'ok',
        meta: expect.objectContaining({ onBehalfOf: 'u_1', via: 'mcp' }),
      }),
    ]);
  });

  it('does not audit a successful read', async () => {
    const { registry, audits } = setup();
    expect((await registry.answer(RUNNER, request('fleet.status'))).ok).toBe(
      true,
    );
    expect(audits).toEqual([]);
  });

  it('answers a project method without a project `no_project`', async () => {
    const { registry } = setup();
    const response = await registry.answer(
      RUNNER,
      request('fleet.status', {}, { projectId: undefined }),
    );
    expect(errorOf(response)).toBe('no_project');
  });

  it("answers another runner's project `no_project`", async () => {
    const { registry, calls } = setup({
      projectRow: { ...project, runnerId: 'rn_other' },
    });
    const response = await registry.answer(RUNNER, request('fleet.status'));
    expect(errorOf(response)).toBe('no_project');
    expect(calls).toEqual([]);
  });

  it('runs away.set without a project, with the global role capped', async () => {
    const { registry, calls } = setup({
      localUser: {
        id: 'u_1',
        email: 'me@example.com',
        role: 'admin',
        status: 'active',
      },
    });
    const response = await registry.answer(
      RUNNER,
      request('away.set', { on: true }, { projectId: undefined }),
    );
    expect(response.ok).toBe(true);
    expect(calls[0].call.project).toBeNull();
    expect(calls[0].call.role).toBe('operator');
  });

  it("maps a domain service's budget refusal to `budget_exceeded`", async () => {
    const { registry, audits } = setup();
    const response = await registry.answer(
      RUNNER,
      request('activity.note', { text: 'hello' }),
    );
    expect(errorOf(response)).toBe('budget_exceeded');
    expect(audits[0]).toMatchObject({ result: 'denied' });
  });

  it("answers `internal` when a handler's result fails the method's schema", async () => {
    const { registry } = setup();
    const response = await registry.answer(
      RUNNER,
      request('queue.list', { limit: 5 }),
    );
    expect(errorOf(response)).toBe('internal');
  });

  it('answers `timeout` when the handler outlives the deadline', async () => {
    const registry = new RunnerLocalRequests();
    registry.timeoutMs = 20;
    registry.register({ answer: () => new Promise(() => undefined) });
    expect(
      errorOf(await registry.answer(RUNNER, request('fleet.status'))),
    ).toBe('timeout');
  });
});
