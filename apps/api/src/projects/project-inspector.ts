import type {
  ProjectErrorBody,
  ProjectErrorCode,
  Role,
} from '@agentdock/shared';
import type { ProjectInspection } from '@agentdock/shared/protocol';
import { HttpException, Injectable } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { RunnerWatchList } from '../runners/runner-watch-list';
import { projectError } from './project-error';

/**
 * Runs `project.inspect` / `project.refresh` on a runner and turns every way
 * they can fail into the HTTP error runner-protocol.md maps it to.
 */
@Injectable()
export class ProjectInspector {
  constructor(
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
    private readonly watchList: RunnerWatchList,
  ) {}

  /** Admin only (the command's minimum role): any existing absolute directory. */
  inspect(
    runnerId: string,
    path: string,
    ctx: AuditContext,
  ): Promise<ProjectInspection> {
    return this.run(runnerId, 'project.inspect', { path }, 'admin', ctx);
  }

  /** Re-inspects a registered root; operator and up on that project. */
  async refresh(
    project: { id: string; runnerId: string; rootPath: string },
    role: Role,
    ctx: AuditContext,
  ): Promise<ProjectInspection> {
    try {
      return await this.run(
        project.runnerId,
        'project.refresh',
        { projectId: project.id, root: project.rootPath },
        role,
        ctx,
      );
    } catch (error) {
      // The runner's watch list lacks the project: resend it, so the caller's
      // retry succeeds (runner-protocol.md "Error codes").
      if (errorCode(error) === 'path_not_allowed') {
        await this.watchList.push(project.runnerId);
      }
      throw error;
    }
  }

  private async run(
    runnerId: string,
    name: 'project.inspect' | 'project.refresh',
    args: Record<string, string>,
    role: Role,
    ctx: AuditContext,
  ): Promise<ProjectInspection> {
    if (!this.presence.isConnected(runnerId)) {
      throw projectError(409, 'runner_offline', 'The runner is not connected');
    }
    const result = await this.commands.send(runnerId, name, args, {
      role,
      ctx,
    });
    switch (result.status) {
      case 'ok':
        return result.output;
      case 'unknown':
        throw projectError(
          504,
          'runner_timeout',
          'The runner did not answer in time',
        );
      case 'error': {
        const { code, message } = result.error;
        const detail = message ?? code;
        switch (code) {
          case 'path_not_found':
            throw projectError(422, 'path_not_found', detail);
          case 'not_a_repository':
            throw projectError(422, 'not_a_repository', detail);
          case 'path_not_allowed':
            throw projectError(403, 'path_not_allowed', detail);
          default:
            throw projectError(502, 'runner_error', `${name}: ${detail}`);
        }
      }
    }
  }
}

const errorCode = (error: unknown): ProjectErrorCode | undefined =>
  error instanceof HttpException
    ? (error.getResponse() as Partial<ProjectErrorBody>).error
    : undefined;
