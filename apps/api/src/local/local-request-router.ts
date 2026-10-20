import type { AuditResult, Role } from '@nautelle/shared';
import {
  LOCAL_ROLE_CAP,
  type LocalErrorCode,
  type LocalMethodArgs,
  type LocalMethodName,
  type LocalMethodResult,
  type LocalRequestMessage,
  type LocalResponseMessage,
  localMethods,
  parseLocalRequest,
  roleAtLeast,
} from '@nautelle/shared/protocol';
import {
  HttpException,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditActor } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import {
  type LocalRequestHandler,
  localFailure,
  RunnerLocalRequests,
} from '../runners/runner-local-requests';
import type { LocalCall, LocalHandler, LocalProject } from './local-call';
import { LocalError, toLocalError } from './local-error';
import { LocalHandlers } from './local-handlers';

/** D8: a local request never acts with more than `operator`. */
export const capLocalRole = (role: Role): Role =>
  roleAtLeast(role, LOCAL_ROLE_CAP) ? LOCAL_ROLE_CAP : role;

const runnerActor = (runnerId: string): AuditActor => ({
  type: 'runner',
  runnerId,
});

/** What the router knows about the request when it audits it. */
interface Audited {
  runnerId: string;
  request: LocalRequestMessage;
  userId: string | null;
  projectId: string | null;
}

/**
 * The server side of `local.request` (spec 201 D6–D8, ADR-0020 §4). In order:
 * the method and its args against the allowlist; the runner's local user;
 * for a project method, that the runner watches the project and the user's
 * role on it, capped at `operator`; the method's `minRole`. Then the handler,
 * and its result checked against the method's result schema.
 *
 * Every refusal is audited as `local.request` with result `denied`, and every
 * write (a method above `viewer`) with its outcome; actor `runner{runnerId}`,
 * `meta.onBehalfOf` the local user, `meta.via` the plugin process.
 */
@Injectable()
export class LocalRequestRouter implements LocalRequestHandler, OnModuleInit {
  private readonly logger = new Logger(LocalRequestRouter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly audit: AuditService,
    private readonly handlers: LocalHandlers,
    private readonly registry: RunnerLocalRequests,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async answer(
    runnerId: string,
    request: LocalRequestMessage,
  ): Promise<LocalResponseMessage> {
    const audited: Audited = {
      runnerId,
      request,
      userId: null,
      projectId: null,
    };
    const deny = async (code: LocalErrorCode, message: string) => {
      await this.record(audited, 'denied', { reason: code });
      return localFailure(request.id, code, message);
    };

    const parsed = parseLocalRequest(request.method, request.args);
    if (!parsed.ok) return deny(parsed.error.code, parsed.error.message);
    const method = parsed.method;
    const definition = localMethods[method];

    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: {
        localUser: {
          select: { id: true, email: true, role: true, status: true },
        },
      },
    });
    const user = runner?.localUser;
    if (!user || user.status !== 'active') {
      return deny('forbidden', 'this runner has no active local user');
    }
    audited.userId = user.id;

    let project: LocalProject | null = null;
    let role: Role;
    if (definition.needsProject) {
      if (!request.projectId) {
        return deny(
          'no_project',
          'the session is outside every watched project',
        );
      }
      project = await this.prisma.project.findUnique({
        where: { id: request.projectId },
        select: {
          id: true,
          runnerId: true,
          rootPath: true,
          repo: true,
          displayName: true,
          baseBranch: true,
          baseOverride: true,
        },
      });
      if (project?.runnerId !== runnerId) {
        return deny('no_project', 'not a project this runner watches');
      }
      audited.projectId = project.id;
      const access = await this.access.resolve(user, project.id);
      if (!access) {
        return deny(
          'forbidden',
          'the local user is not a member of the project',
        );
      }
      role = capLocalRole(access.role);
    } else {
      role = capLocalRole(user.role);
    }
    if (!roleAtLeast(role, definition.minRole)) {
      return deny(
        'forbidden',
        `${method} needs the ${definition.minRole} role; the local role is ${role}`,
      );
    }

    const meta = { onBehalfOf: user.id, via: request.via };
    const call: LocalCall = {
      runnerId,
      requestId: request.id,
      user: { id: user.id, email: user.email, role: user.role },
      role,
      project,
      session: request.session ?? null,
      via: request.via,
      ctx: { actor: runnerActor(runnerId) },
      meta,
    };
    const write = definition.minRole !== 'viewer';

    let data: unknown;
    try {
      data = await this.run(method, parsed.args, call);
    } catch (error) {
      const failure = toLocalError(error);
      if (!(error instanceof HttpException || error instanceof LocalError)) {
        this.logger.error(
          `local ${method} from runner ${runnerId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const result: AuditResult =
        failure.code === 'internal' || failure.code === 'runner_offline'
          ? 'error'
          : 'denied';
      if (write || result === 'denied') {
        await this.record(audited, result, { reason: failure.code });
      }
      return localFailure(request.id, failure.code, failure.message);
    }

    const checked = definition.result.safeParse(data);
    if (!checked.success) {
      this.logger.error(
        `local ${method}: the handler's result fails its schema`,
      );
      if (write) await this.record(audited, 'error', { reason: 'internal' });
      return localFailure(request.id, 'internal', 'internal error');
    }
    if (write) await this.record(audited, 'ok');
    return {
      type: 'local.response',
      id: request.id,
      ok: true,
      data: checked.data,
    };
  }

  private run<N extends LocalMethodName>(
    method: N,
    args: unknown,
    call: LocalCall,
  ): Promise<LocalMethodResult<N>> {
    const handler = this.handlers.table[method] as LocalHandler<N>;
    // `parseLocalRequest` validated `args` against this method's schema.
    return handler(args as LocalMethodArgs<N>, call);
  }

  private record(
    audited: Audited,
    result: AuditResult,
    extra: object = {},
  ): Promise<void> {
    const { request } = audited;
    return this.audit.record({
      actor: runnerActor(audited.runnerId),
      action: 'local.request',
      target: { type: 'runner', id: audited.runnerId },
      projectId: audited.projectId,
      after: { method: request.method, requestId: request.id },
      result,
      meta: {
        ...extra,
        via: request.via,
        ...(audited.userId ? { onBehalfOf: audited.userId } : {}),
        ...(request.session ? { sessionId: request.session.id } : {}),
      },
    });
  }
}
