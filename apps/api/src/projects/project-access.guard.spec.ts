import type { Role } from '@agentdock/shared';
import type { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../auth';
import type { PrismaService } from '../database/prisma.service';
import { ProjectAccessGuard, ProjectRole } from './project-access.guard';
import {
  ProjectAccessService,
  type ResolvedProjectAccess,
} from './project-access.service';

const PROJECT = 'prj_a';

const user = (id: string, role: Role): AuthUser => ({
  id,
  email: `${id}@example.com`,
  name: null,
  role,
  status: 'active',
});

/**
 * A database with one project, `prj_a`, and the given memberships
 * (`userId → roleOverride`).
 */
const access = (members: Record<string, Role | null>) => {
  const prisma = {
    project: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === PROJECT ? { id: PROJECT } : null),
      ),
    },
    projectMember: {
      findUnique: jest.fn(
        ({
          where,
        }: {
          where: { projectId_userId: { projectId: string; userId: string } };
        }) => {
          const { projectId, userId } = where.projectId_userId;
          return Promise.resolve(
            projectId === PROJECT && userId in members
              ? { roleOverride: members[userId] }
              : null,
          );
        },
      ),
    },
  };
  return {
    service: new ProjectAccessService(prisma as unknown as PrismaService),
    prisma,
  };
};

class Routes {
  @ProjectRole('operator')
  operatorRoute(): void {}

  anyMemberRoute(): void {}
}

const context = (
  caller: AuthUser | undefined,
  projectId: string,
  handler: keyof Routes,
) => {
  const request: {
    params: Record<string, string>;
    auth?: { user: AuthUser; sessionId: string };
    projectAccess?: ResolvedProjectAccess;
  } = {
    params: { projectId },
    ...(caller ? { auth: { user: caller, sessionId: 's' } } : {}),
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
  } as unknown as ExecutionContext;
  return { ctx, request };
};

const outcome = (promise: Promise<boolean>) =>
  promise.then(
    () => 'allowed' as const,
    (error: HttpException) => error.getStatus(),
  );

describe('ProjectAccessService', () => {
  it('lets an admin see every existing project as admin, with no membership row', async () => {
    const { service, prisma } = access({});
    expect(await service.resolve(user('a1', 'admin'), PROJECT)).toEqual({
      projectId: PROJECT,
      role: 'admin',
    });
    expect(await service.resolve(user('a1', 'admin'), 'prj_x')).toBeNull();
    expect(prisma.projectMember.findUnique).not.toHaveBeenCalled();
  });

  it('keeps an admin admin even when a member row carries a lower override', async () => {
    const { service } = access({ a1: 'viewer' });
    expect((await service.resolve(user('a1', 'admin'), PROJECT))?.role).toBe(
      'admin',
    );
  });

  it('gives a member their global role, lowered by an override but never raised', async () => {
    const { service } = access({
      o1: null,
      o2: 'viewer',
      v1: 'operator',
      v2: 'admin',
    });
    const roleOf = async (id: string, role: Role) =>
      (await service.resolve(user(id, role), PROJECT))?.role;
    expect(await roleOf('o1', 'operator')).toBe('operator');
    expect(await roleOf('o2', 'operator')).toBe('viewer');
    expect(await roleOf('v1', 'viewer')).toBe('viewer');
    expect(await roleOf('v2', 'viewer')).toBe('viewer');
  });

  it('gives a non-member nothing', async () => {
    const { service } = access({ o1: null });
    expect(await service.resolve(user('o2', 'operator'), PROJECT)).toBeNull();
  });

  it('filters lists by membership for everyone but admins', () => {
    const { service } = access({});
    expect(service.visibleWhere(user('a1', 'admin'))).toEqual({});
    expect(service.visibleWhere(user('v1', 'viewer'))).toEqual({
      members: { some: { userId: 'v1' } },
    });
  });
});

describe('ProjectAccessGuard', () => {
  const guard = (members: Record<string, Role | null>) =>
    new ProjectAccessGuard(new Reflector(), access(members).service);

  it('lets an admin through without a membership and records the access', async () => {
    const { ctx, request } = context(
      user('a1', 'admin'),
      PROJECT,
      'operatorRoute',
    );
    expect(await outcome(guard({}).canActivate(ctx))).toBe('allowed');
    expect(request.projectAccess).toEqual({
      projectId: PROJECT,
      role: 'admin',
    });
  });

  it('lets a member through when their effective role meets the route', async () => {
    const g = guard({ o1: null, v1: null });
    expect(
      await outcome(
        g.canActivate(
          context(user('o1', 'operator'), PROJECT, 'operatorRoute').ctx,
        ),
      ),
    ).toBe('allowed');
    expect(
      await outcome(
        g.canActivate(
          context(user('v1', 'viewer'), PROJECT, 'anyMemberRoute').ctx,
        ),
      ),
    ).toBe('allowed');
  });

  it('answers 404 to a non-member, whatever the route needs', async () => {
    const g = guard({ o1: null });
    for (const handler of ['operatorRoute', 'anyMemberRoute'] as const) {
      expect(
        await outcome(
          g.canActivate(context(user('v9', 'viewer'), PROJECT, handler).ctx),
        ),
      ).toBe(404);
    }
    expect(
      await outcome(
        g.canActivate(
          context(user('a1', 'admin'), 'prj_missing', 'anyMemberRoute').ctx,
        ),
      ),
    ).toBe(404);
  });

  it('answers 403 when an override lowers a member below the route', async () => {
    const g = guard({ o1: 'viewer', v1: 'operator' });
    expect(
      await outcome(
        g.canActivate(
          context(user('o1', 'operator'), PROJECT, 'operatorRoute').ctx,
        ),
      ),
    ).toBe(403);
    // An override cannot raise: a viewer with `operator` stays a viewer.
    expect(
      await outcome(
        g.canActivate(
          context(user('v1', 'viewer'), PROJECT, 'operatorRoute').ctx,
        ),
      ),
    ).toBe(403);
  });

  it('answers 401 without a session', async () => {
    expect(
      await outcome(
        guard({}).canActivate(
          context(undefined, PROJECT, 'anyMemberRoute').ctx,
        ),
      ),
    ).toBe(401);
  });
});
