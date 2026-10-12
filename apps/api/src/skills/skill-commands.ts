import { SKILLS_ERROR } from '@agentdock/shared';
import {
  type CommandErrorCode,
  isCommandName,
  type SkillCommandName,
  skillCommands,
} from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import {
  RunnerCommandService,
  type SendOptions,
} from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { SkillsFailure } from './skills-error';

export type SkillCommandArgs<N extends SkillCommandName> = z.input<
  (typeof skillCommands)[N]['args']
>;
export type SkillCommandOutput<N extends SkillCommandName> = z.infer<
  (typeof skillCommands)[N]['result']
>;

/** How a skill command ended — `RunnerCommandService.send`'s shape. */
export type SkillSendResult<N extends SkillCommandName> =
  | { status: 'ok'; output: SkillCommandOutput<N> }
  | { status: 'error'; error: { code: CommandErrorCode; message?: string } }
  | { status: 'unknown' };

/**
 * The one place the skills module sends runner commands (spec 24 notes).
 *
 * `skillCommands` is defined in the protocol but entered in the `commands`
 * allowlist only with the runner's handlers (i24-runner). Until then a skill
 * command answers 503 `command_unavailable`, sending nothing; once the
 * allowlist holds it, it goes through `RunnerCommandService` — role check,
 * `runner.command` audit, timeout — with no change here.
 */
@Injectable()
export class SkillCommands {
  constructor(
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  /** Throws 503 `command_unavailable` when `name` cannot be sent to `runnerId` now. */
  assertReady(runnerId: string, name: SkillCommandName): void {
    const wired: string = name;
    if (!isCommandName(wired)) {
      throw new SkillsFailure(
        503,
        SKILLS_ERROR.commandUnavailable,
        `${name} is not available on the runner yet`,
      );
    }
    if (!this.presence.isConnected(runnerId)) {
      throw new SkillsFailure(
        503,
        SKILLS_ERROR.commandUnavailable,
        'The runner is not connected',
      );
    }
  }

  async send<N extends SkillCommandName>(
    runnerId: string,
    name: N,
    args: SkillCommandArgs<N>,
    options: SendOptions,
  ): Promise<SkillSendResult<N>> {
    this.assertReady(runnerId, name);
    const wired: string = name;
    if (!isCommandName(wired)) throw new Error('unreachable');
    const result = await this.commands.send(runnerId, wired, args, options);
    if (result.status !== 'ok') return result;
    const output = skillCommands[name].result.safeParse(result.output);
    if (!output.success) {
      return {
        status: 'error',
        error: { code: 'internal', message: 'malformed result' },
      };
    }
    return { status: 'ok', output: output.data as SkillCommandOutput<N> };
  }
}

/**
 * The output of a sent command, or the failure that says why there is none
 * (runner-protocol.md "Error codes", spec 24 notes).
 */
export const skillOutput = <N extends SkillCommandName>(
  name: N,
  result: SkillSendResult<N>,
): SkillCommandOutput<N> => {
  switch (result.status) {
    case 'ok':
      return result.output;
    case 'unknown':
      throw new SkillsFailure(
        504,
        SKILLS_ERROR.runnerTimeout,
        `The runner did not answer ${name} in time`,
      );
    case 'error':
      throw skillFailureOf(name, result.error);
  }
};

const MAPPED: Partial<
  Record<CommandErrorCode, { status: number; code: SkillsFailure['code'] }>
> = {
  invalid_args: { status: 400, code: SKILLS_ERROR.invalidArgs },
  not_found: { status: 404, code: SKILLS_ERROR.notFound },
  path_not_found: { status: 404, code: SKILLS_ERROR.notFound },
  changed_since_preview: {
    status: 409,
    code: SKILLS_ERROR.changedSincePreview,
  },
  already_exists: { status: 409, code: SKILLS_ERROR.alreadyExists },
  not_runnable: { status: 422, code: SKILLS_ERROR.notRunnable },
  unsupported_runtime: { status: 422, code: SKILLS_ERROR.unsupportedRuntime },
  unknown_profile: { status: 422, code: SKILLS_ERROR.unknownProfile },
  too_large: { status: 422, code: SKILLS_ERROR.tooLarge },
  upstream_unavailable: {
    status: 502,
    code: SKILLS_ERROR.upstreamUnavailable,
  },
  timeout: { status: 504, code: SKILLS_ERROR.runnerTimeout },
};

export const skillFailureOf = (
  name: string,
  error: { code: CommandErrorCode; message?: string },
): SkillsFailure => {
  const mapped = MAPPED[error.code];
  const detail = error.message ?? error.code;
  if (mapped) return new SkillsFailure(mapped.status, mapped.code, detail);
  return new SkillsFailure(
    502,
    SKILLS_ERROR.commandFailed,
    `${name} failed on the runner: ${error.code}${error.message ? ` — ${error.message}` : ''}`,
  );
};
