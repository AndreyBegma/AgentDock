import type { BackfillRequest, BackfillResponse } from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { sessionError } from './session-error';

/**
 * `POST /admin/runners/:id/backfill` (D11): sends `session.backfill` and turns
 * every way it can fail into an HTTP error. The re-read itself happens on the
 * runner (ADR-0001); the events it produces arrive through the usual ingest.
 */
@Injectable()
export class SessionsBackfillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  /** Admin only: the route's role and the command's minimum role. */
  async backfill(
    runnerId: string,
    request: BackfillRequest,
    ctx: AuditContext,
  ): Promise<BackfillResponse> {
    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { id: true },
    });
    if (!runner) throw sessionError(404, 'not_found', 'Runner not found');
    if (request.projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: request.projectId, runnerId },
        select: { id: true },
      });
      if (!project) {
        throw sessionError(
          404,
          'not_found',
          'Project not found on this runner',
        );
      }
    }
    if (!this.presence.isConnected(runnerId)) {
      throw sessionError(409, 'runner_offline', 'The runner is not connected');
    }

    const result = await this.commands.send(
      runnerId,
      'session.backfill',
      request,
      { role: 'admin', ctx },
    );
    switch (result.status) {
      case 'ok':
        return result.output;
      case 'unknown':
        throw sessionError(
          504,
          'runner_timeout',
          'The runner did not answer in time; the backfill may still be running',
        );
      case 'error': {
        const { code, message } = result.error;
        const detail = `${code}: ${message ?? code}`;
        if (code === 'internal' || code === 'timeout') {
          throw sessionError(502, 'runner_error', detail);
        }
        throw sessionError(409, 'runner_refused', detail);
      }
    }
  }
}
