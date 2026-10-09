import { RUNNER_ERROR } from '@agentdock/shared';
import {
  type PairingResponse,
  RUNNER_CLOSE_CODES,
} from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ANONYMOUS_ACTOR, type RequestOrigin } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import {
  generateRunnerToken,
  hashPairingCode,
  hashRunnerToken,
  normalizePairingCode,
  tokenPrefix,
} from './credentials';
import type { PairRunnerDto } from './dto';
import { RunnerConnections } from './runner-connections';
import { runnerError } from './runner-error';

const ATTEMPTS = 3;

/** One response for an unknown, malformed, expired or used code: nothing to probe. */
const invalidCode = () =>
  runnerError(
    400,
    RUNNER_ERROR.invalidCode,
    'The pairing code is invalid, expired or already used',
  );

/** `runnerId` when the code belonged to a runner — expired, used, or revoked. */
class InvalidCode extends Error {
  constructor(readonly runnerId: string | null = null) {
    super('invalid pairing code');
  }
}

/** `POST /runners/pair`: one-time code → long-lived runner token (spec D1, D2). */
@Injectable()
export class PairingService {
  private readonly logger = new Logger(PairingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: RunnerConnections,
    private readonly audit: AuditService,
  ) {}

  async pair(
    dto: PairRunnerDto,
    origin: RequestOrigin,
  ): Promise<PairingResponse> {
    // The code itself is never recorded — `code` is a redacted key anyway.
    const denied = async (runnerId: string | null) => {
      await this.audit.record({
        actor: ANONYMOUS_ACTOR,
        origin,
        action: 'runner.pair',
        target: { type: 'runner', id: runnerId },
        after: { hostname: dto.hostname, version: dto.version },
        result: 'denied',
        meta: { reason: 'invalid_code' },
      });
      return invalidCode();
    };
    const code = normalizePairingCode(dto.code);
    if (!code) throw await denied(null);
    const codeHash = hashPairingCode(code);

    for (let attempt = 1; ; attempt += 1) {
      const token = generateRunnerToken();
      const tokenHash = await hashRunnerToken(token);
      try {
        const runnerId = await this.exchange(codeHash, token, tokenHash, dto);
        // A re-pairing runner's old token is dead; so is any socket using it.
        this.connections.disconnect(
          runnerId,
          RUNNER_CLOSE_CODES.unauthorized,
          're-paired',
        );
        this.logger.log(`runner ${runnerId} paired`);
        await this.audit.record({
          actor: { type: 'runner', runnerId },
          origin,
          action: 'runner.pair',
          target: { type: 'runner', id: runnerId },
          after: { hostname: dto.hostname, version: dto.version },
          result: 'ok',
        });
        return { runnerId, token };
      } catch (error) {
        if (error instanceof InvalidCode) throw await denied(error.runnerId);
        const prefixTaken =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002';
        if (!prefixTaken || attempt >= ATTEMPTS) throw error;
      }
    }
  }

  /** Uses the code and stores the token's hash, atomically. */
  private exchange(
    codeHash: string,
    token: string,
    tokenHash: string,
    dto: PairRunnerDto,
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const row = await tx.runnerPairingCode.findUnique({
        where: { codeHash },
        select: {
          id: true,
          runnerId: true,
          runner: { select: { revokedAt: true } },
        },
      });
      if (!row) throw new InvalidCode();
      if (row.runner.revokedAt) throw new InvalidCode(row.runnerId);
      // Conditional: of two concurrent pairings with one code, one wins.
      const used = await tx.runnerPairingCode.updateMany({
        where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (used.count !== 1) throw new InvalidCode(row.runnerId);
      await tx.runner.update({
        where: { id: row.runnerId },
        data: {
          tokenHash,
          tokenPrefix: tokenPrefix(token),
          pairedAt: now,
          hostname: dto.hostname,
          version: dto.version,
          protocolVersion: dto.protocolVersion,
        },
      });
      return row.runnerId;
    });
  }
}
