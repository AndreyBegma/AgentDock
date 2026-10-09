import {
  TERMINAL_ERROR,
  type TerminalAttachView,
  type TerminalErrorBody,
  type TerminalErrorCode,
  type TerminalTicketResponse,
} from '@agentdock/shared';
import {
  capabilitiesSchema,
  type TerminalTarget,
  terminalAvailable,
} from '@agentdock/shared/protocol';
import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService, projectNotFound } from '../projects';
import type { TerminalTicketDto } from './dto';
import { TerminalRelay } from './terminal-relay';
import { TerminalTickets } from './terminal-tickets';

const terminalError = (
  statusCode: number,
  error: TerminalErrorCode,
  message: string,
  extra: Pick<TerminalErrorBody, 'heldBy'> = {},
): HttpException => {
  const body: TerminalErrorBody = { statusCode, error, message, ...extra };
  return new HttpException(body, statusCode);
};

/** The target the runner resolves (D2): kind and ids, plus the project's root. */
const targetOf = (dto: TerminalTicketDto, root: string): TerminalTarget => {
  const base = { projectId: dto.projectId, root };
  if (dto.kind !== 'slot' && dto.slot !== undefined) {
    throw new BadRequestException(`slot is only allowed with kind slot`);
  }
  if (dto.kind !== 'skill_run' && dto.runId !== undefined) {
    throw new BadRequestException(`runId is only allowed with kind skill_run`);
  }
  switch (dto.kind) {
    case 'slot':
      return { kind: 'slot', ...base, slot: dto.slot ?? '' };
    case 'orchestrator':
      return { kind: 'orchestrator', ...base };
    case 'skill_run':
      return { kind: 'skill_run', ...base, runId: dto.runId ?? '' };
  }
};

/** Tickets and the active list (spec 29 "API"); the attach itself is the gateway's. */
@Injectable()
export class TerminalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly tickets: TerminalTickets,
    private readonly relay: TerminalRelay,
  ) {}

  /**
   * D5 step 1. Refused early when the runner cannot attach at all (D10) or
   * another admin holds the read-write attach (D7); the runner checks both
   * again when the socket opens.
   */
  async issueTicket(
    auth: AuthContext,
    dto: TerminalTicketDto,
  ): Promise<TerminalTicketResponse> {
    if (!(await this.access.resolve(auth.user, dto.projectId))) {
      throw projectNotFound();
    }
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      select: {
        runnerId: true,
        rootPath: true,
        runner: { select: { capabilities: true } },
      },
    });
    if (!project) throw projectNotFound();
    const target = targetOf(dto, project.rootPath);

    const capabilities = capabilitiesSchema.safeParse(
      project.runner.capabilities,
    );
    if (!capabilities.success || !terminalAvailable(capabilities.data)) {
      throw terminalError(
        409,
        TERMINAL_ERROR.unsupported,
        'The project runner does not offer terminal attach',
      );
    }
    if (dto.mode === 'write') {
      const holder = this.relay.writeHolder(target);
      if (holder) {
        throw terminalError(
          409,
          TERMINAL_ERROR.busy,
          `${holder.email} is in control of this session`,
          { heldBy: holder },
        );
      }
    }

    const issued = this.tickets.issue({
      userId: auth.user.id,
      sessionId: auth.sessionId,
      runnerId: project.runnerId,
      target,
      mode: dto.mode,
    });
    return { ticket: issued.ticket, expiresAt: issued.expiresAt.toISOString() };
  }

  async active(
    auth: AuthContext,
    projectId: string,
  ): Promise<TerminalAttachView[]> {
    if (!(await this.access.resolve(auth.user, projectId))) {
      throw projectNotFound();
    }
    return this.relay.active(projectId);
  }
}
