import { createHash } from 'node:crypto';
import {
  cleanSessionMessageInput,
  SESSION_MESSAGE_ERROR,
  type SessionMessageErrorCode,
  type SessionMessageInput,
  type SessionMessageOutcome,
  type SessionMessageVia,
} from '@nautelle/shared';
import {
  capabilitiesSchema,
  commandPolicyRefusalOf,
  policyRefusalMessage,
  type Role,
  type SessionMessageArgs,
  type SessionMessageTarget,
  sessionMessageArgsSchema,
  sessionMessageAvailable,
} from '@nautelle/shared/protocol';
import { HttpException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';

/** An HTTP error of a message route, shaped like every other API error. */
export const sessionMessageError = (
  statusCode: number,
  error: SessionMessageErrorCode,
  message: string,
): HttpException =>
  new HttpException({ statusCode, error, message }, statusCode);

export interface SessionMessageSend {
  projectId: string;
  runnerId: string;
  target: SessionMessageTarget;
  input: SessionMessageInput;
  role: Role;
  ctx: AuditContext;
  via: SessionMessageVia;
}

const sha256 = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** M1: what the audit log keeps of a message — never the text itself. */
const auditedInput = (input: SessionMessageInput) =>
  input.kind === 'option'
    ? { kind: input.kind, questionKey: input.questionKey, index: input.index }
    : {
        kind: input.kind,
        ...(input.kind === 'other' ? { questionKey: input.questionKey } : {}),
        textSha256: sha256(input.text),
        textChars: input.text.length,
      };

/**
 * #913: why the runner's local policy (ADR-0047) refuses every message, in
 * the runner's own words — the rule and the CLI line that lifts it.
 */
export const SESSION_MESSAGE_POLICY_REFUSAL = policyRefusalMessage(
  'commands',
  'session.message is off on this runner',
  'session.message',
);

const auditedTarget = (target: SessionMessageTarget) =>
  target.kind === 'card_round'
    ? { kind: target.kind, cardId: target.cardId, runId: target.runId }
    : { kind: target.kind, slot: target.slot };

/**
 * #489: the one place a person's message to a running session is sent —
 * from the Board, the terminal view, the Fleet page and Telegram. The text
 * is cleaned (M1), the runner must serve `session.message` (capability
 * `sessionMessage`) and its local policy must allow it (ADR-0047, #913),
 * and every message — sent, refused or failed — is one
 * `card.message` / `slot.session_message` audit row holding the text's hash
 * and length, never the text.
 */
@Injectable()
export class SessionMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
    private readonly audit: AuditService,
  ) {}

  /** Whether `session.message` can be sent to `runnerId` now. */
  async available(runnerId: string): Promise<boolean> {
    if (!this.presence.isConnected(runnerId)) return false;
    if (this.presence.missingCommand(runnerId, ['session.message'])) {
      return false;
    }
    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { capabilities: true, revokedAt: true },
    });
    if (!runner || runner.revokedAt !== null) return false;
    const capabilities = capabilitiesSchema.safeParse(runner.capabilities);
    return capabilities.success && sessionMessageAvailable(capabilities.data);
  }

  /**
   * #913: why the policy `runnerId` last reported refuses `session.message`,
   * or null. A runner older than the policy reports none and refuses nothing.
   */
  async policyRefusal(runnerId: string): Promise<string | null> {
    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { capabilities: true },
    });
    return runner
      ? commandPolicyRefusalOf(runner.capabilities, 'session.message')
      : null;
  }

  async send(
    message: SessionMessageSend,
  ): Promise<{ outcome: SessionMessageOutcome }> {
    const cleaned = cleanSessionMessageInput(message.input);
    const record = (
      result: 'ok' | 'error',
      outcome: { outcome?: SessionMessageOutcome; error?: string },
    ) =>
      this.audit.record({
        ...message.ctx,
        action:
          message.target.kind === 'card_round'
            ? 'card.message'
            : 'slot.session_message',
        target:
          message.target.kind === 'card_round'
            ? { type: 'board_card', id: message.target.cardId }
            : { type: 'slot', id: message.target.slot },
        projectId: message.projectId,
        after: {
          target: auditedTarget(message.target),
          ...auditedInput(cleaned ?? message.input),
          via: message.via,
          ...outcome,
        },
        result,
      });

    const args: SessionMessageArgs | null = cleaned
      ? {
          projectId: message.projectId,
          target: message.target,
          message: cleaned,
        }
      : null;
    if (!args || !sessionMessageArgsSchema.safeParse(args).success) {
      await record('error', { error: SESSION_MESSAGE_ERROR.invalidMessage });
      throw sessionMessageError(
        400,
        SESSION_MESSAGE_ERROR.invalidMessage,
        'The message is empty once control characters are removed',
      );
    }
    if (!(await this.available(message.runnerId))) {
      await record('error', {
        error: SESSION_MESSAGE_ERROR.commandUnavailable,
      });
      throw sessionMessageError(
        503,
        SESSION_MESSAGE_ERROR.commandUnavailable,
        'The runner is offline or does not take session messages; update it',
      );
    }
    const refusal = await this.policyRefusal(message.runnerId);
    if (refusal !== null) {
      await record('error', { error: SESSION_MESSAGE_ERROR.policyRefused });
      throw sessionMessageError(
        403,
        SESSION_MESSAGE_ERROR.policyRefused,
        refusal,
      );
    }
    const sent = await this.commands.send(
      message.runnerId,
      'session.message',
      args,
      {
        role: message.role,
        ctx: message.ctx,
        auditArgs: {
          projectId: args.projectId,
          target: auditedTarget(args.target),
          message: auditedInput(args.message),
        },
      },
    );
    if (sent.status === 'unknown') {
      await record('error', { error: SESSION_MESSAGE_ERROR.runnerTimeout });
      throw sessionMessageError(
        504,
        SESSION_MESSAGE_ERROR.runnerTimeout,
        'The runner did not answer in time; the message may have arrived',
      );
    }
    if (sent.status === 'error') {
      await record('error', { error: sent.error.code });
      // The policy may have changed since the runner's last hello.
      if (sent.error.code === 'policy_refused') {
        throw sessionMessageError(
          403,
          SESSION_MESSAGE_ERROR.policyRefused,
          sent.error.message ?? SESSION_MESSAGE_POLICY_REFUSAL,
        );
      }
      throw sessionMessageError(
        sent.error.code === 'not_found' ? 409 : 502,
        sent.error.code === 'not_found'
          ? SESSION_MESSAGE_ERROR.notRunning
          : SESSION_MESSAGE_ERROR.runnerError,
        sent.error.message ?? `The runner refused it (${sent.error.code})`,
      );
    }
    const { outcome } = sent.output;
    await record(
      outcome === 'sent' || outcome === 'answered' ? 'ok' : 'error',
      { outcome },
    );
    return { outcome };
  }
}
