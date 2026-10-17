import type {
  SessionMessageInput,
  SessionMessageVia,
  SessionMessageView,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import { SessionMessageService } from '../session-message/session-message.service';
import type { ControlCaller } from './control.service';

/**
 * #489 M5, ADR-0045: a person's text or answer typed into a fleet worker's
 * `cs-*` pane. The runner also appends it to the orchestrator's
 * `events.jsonl` as `slot.message_sent` with `by: person`, so the
 * orchestrator still knows what each of its workers was told.
 */
@Injectable()
export class SlotSessionMessages {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: SessionMessageService,
  ) {}

  async message(
    caller: ControlCaller,
    slot: string,
    input: SessionMessageInput,
    via: SessionMessageVia = 'web',
  ): Promise<SessionMessageView> {
    const project = await this.prisma.project.findUnique({
      where: { id: caller.projectId },
      select: { runnerId: true, rootPath: true },
    });
    if (!project) throw projectNotFound();
    return this.messages.send({
      projectId: caller.projectId,
      runnerId: project.runnerId,
      target: { kind: 'fleet_slot', root: project.rootPath, slot },
      input,
      role: caller.role,
      ctx: caller.ctx,
      via,
    });
  }
}
