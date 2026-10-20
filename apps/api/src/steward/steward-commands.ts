import type { stewardCommands } from '@nautelle/shared/protocol';
import {
  type CommandResult,
  capabilitiesSchema,
  type StewardCommandName,
  stewardAvailable,
} from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import {
  type CommandSendResult,
  RunnerCommandService,
  type SendOptions,
} from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';

export type StewardCommandArgs<N extends StewardCommandName> = z.input<
  (typeof stewardCommands)[N]['args']
>;
export type StewardCommandOutput<N extends StewardCommandName> =
  CommandResult<N>;

/**
 * The one place Steward sends runner commands (#447 D2, ADR-0010): only to
 * a connected runner whose capabilities say `steward: true` and that serves
 * the command. Everything else about a command — role check, the
 * `runner.command` audit, the timeout — is `RunnerCommandService`'s.
 */
@Injectable()
export class StewardCommands {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  /** Whether `name` can be sent to `runnerId` now. */
  async available(
    runnerId: string,
    name: StewardCommandName,
  ): Promise<boolean> {
    if (!this.presence.isConnected(runnerId)) return false;
    if (this.presence.missingCommand(runnerId, [name])) return false;
    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { capabilities: true, revokedAt: true },
    });
    if (!runner || runner.revokedAt !== null) return false;
    const capabilities = capabilitiesSchema.safeParse(runner.capabilities);
    return capabilities.success && stewardAvailable(capabilities.data);
  }

  send<N extends StewardCommandName>(
    runnerId: string,
    name: N,
    args: StewardCommandArgs<N>,
    options: SendOptions,
  ): Promise<CommandSendResult<N>> {
    return this.commands.send(runnerId, name, args, options);
  }
}
