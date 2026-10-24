import {
  type CardDemoArgs,
  capabilitiesSchema,
  cardDemoAvailable,
} from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import {
  type CommandSendResult,
  RunnerCommandService,
} from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';

/**
 * C-370 (ADR-0095): `card.demo` to a project's runner — the one seam between
 * a card's demo and the socket, so a test answers it in one place. A demo
 * the runner cannot take is `skipped` by the caller with `unavailable`'s
 * reason; nothing retries it.
 */
@Injectable()
export class DemoRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  /**
   * Why the runner cannot take `card.demo` now, or null: it is offline, its
   * release does not serve the command, or it has it disabled — from its
   * hello, and from the capabilities it last reported (C-369).
   */
  async unavailable(runnerId: string): Promise<string | null> {
    if (!this.presence.isConnected(runnerId)) return 'The runner is offline';
    const support = this.presence.commandSupport(runnerId, 'card.demo');
    if (support === 'missing') {
      return 'The runner does not record demos; update it';
    }
    if (support === 'disabled') {
      return 'The runner has card.demo disabled';
    }
    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { capabilities: true },
    });
    const capabilities = capabilitiesSchema.safeParse(runner?.capabilities);
    if (capabilities.success && !cardDemoAvailable(capabilities.data)) {
      return 'The runner does not record demos';
    }
    return null;
  }

  /** Queues the recording on the runner; it answers once it is queued. */
  record(
    runnerId: string,
    args: CardDemoArgs,
    ctx: AuditContext,
  ): Promise<CommandSendResult<'card.demo'>> {
    return this.commands.send(runnerId, 'card.demo', args, {
      role: 'operator',
      ctx,
    });
  }
}
