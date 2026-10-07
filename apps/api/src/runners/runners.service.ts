import {
  type AdminRunner,
  type AdminRunnerDetail,
  type PairingCodeResponse,
  PAIRING_CODE_TTL_MS,
  type PingResult,
  pairCommand,
  RUNNER_ERROR,
} from '@agentdock/shared';
import { type Capabilities, RUNNER_CLOSE_CODES } from '@agentdock/shared/protocol';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Runner } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { generatePairingCode, hashPairingCode } from './credentials';
import { RunnerCommandService } from './runner-command.service';
import { RunnerConnections } from './runner-connections';
import { runnerError } from './runner-error';
import { toAdminEvent, toAdminProfile, toAdminRunner } from './runner-mapper';
import { RUNNER_OPTIONS, type RunnerOptions } from './runner-options';
import { deriveStatus } from './status';

type Tx = Prisma.TransactionClient;

const RECENT_EVENTS = 50;
const ATTEMPTS = 3;

const notFound = () => runnerError(404, RUNNER_ERROR.notFound, 'Runner not found');

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/** The API origin the runner pairs with (runner-protocol "Transport"). */
const serverOrigin = (): string =>
  (process.env.API_URL ?? 'http://localhost:8180').replace(/\/+$/, '');

const activeProfiles = {
  _count: { select: { profiles: { where: { missing: false } } } },
} as const;

/** Admin operations on runners (spec "API", D1, D9, D10). */
@Injectable()
export class RunnersService {
  private readonly logger = new Logger(RunnersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: RunnerConnections,
    private readonly commands: RunnerCommandService,
    @Inject(RUNNER_OPTIONS) private readonly options: RunnerOptions,
  ) {}

  async create(name: string, adminId: string): Promise<PairingCodeResponse> {
    const { runner, code, expiresAt } = await this.withFreshCode(async (tx) => {
      const created = await tx.runner.create({
        data: { name, createdById: adminId },
      });
      return { runner: created, ...(await this.issueCode(tx, created.id)) };
    });
    this.logger.log(`runner ${runner.id} created`);
    return this.codeResponse(runner, code, expiresAt);
  }

  /** A new code for an unpaired or re-pairing runner; earlier unused ones die. */
  async newPairingCode(id: string): Promise<PairingCodeResponse> {
    const { runner, code, expiresAt } = await this.withFreshCode(async (tx) => {
      const found = await tx.runner.findUnique({
        where: { id },
        include: activeProfiles,
      });
      if (!found) throw notFound();
      if (found.revokedAt) {
        throw runnerError(
          409,
          RUNNER_ERROR.invalidTransition,
          'A revoked runner cannot be paired again',
        );
      }
      return { runner: found, ...(await this.issueCode(tx, id)) };
    });
    return this.codeResponse(runner, code, expiresAt, runner._count.profiles);
  }

  async list(): Promise<AdminRunner[]> {
    const runners = await this.prisma.runner.findMany({
      orderBy: { createdAt: 'asc' },
      include: activeProfiles,
    });
    return runners.map((runner) =>
      toAdminRunner(runner, this.status(runner), runner._count.profiles),
    );
  }

  async detail(id: string): Promise<AdminRunnerDetail> {
    const runner = await this.prisma.runner.findUnique({
      where: { id },
      include: {
        profiles: { orderBy: { key: 'asc' } },
        events: { orderBy: { seq: 'desc' }, take: RECENT_EVENTS },
      },
    });
    if (!runner) throw notFound();
    const live = this.connections.get(id);
    const profiles = runner.profiles.map(toAdminProfile);
    return {
      ...toAdminRunner(
        runner,
        this.status(runner),
        profiles.filter((p) => !p.missing).length,
      ),
      capabilities: (runner.capabilities ?? null) as Capabilities | null,
      profiles,
      events: runner.events.map(toAdminEvent),
      heartbeat: live?.heartbeat ?? null,
      ackedSeq: Number(runner.ackedSeq),
    };
  }

  async rename(id: string, name: string): Promise<AdminRunner> {
    try {
      const runner = await this.prisma.runner.update({
        where: { id },
        data: { name },
        include: activeProfiles,
      });
      return toAdminRunner(runner, this.status(runner), runner._count.profiles);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw notFound();
      }
      throw error;
    }
  }

  /** D10: revokedAt set, socket closed 4401, row and events kept. */
  async revoke(id: string): Promise<AdminRunner> {
    const runner = await this.prisma.$transaction(async (tx) => {
      const found = await tx.runner.findUnique({ where: { id } });
      if (!found) throw notFound();
      await tx.runnerPairingCode.deleteMany({
        where: { runnerId: id, usedAt: null },
      });
      if (found.revokedAt) return tx.runner.findUniqueOrThrow({ where: { id }, include: activeProfiles });
      return tx.runner.update({
        where: { id },
        data: { revokedAt: new Date() },
        include: activeProfiles,
      });
    });
    this.connections.disconnect(id, RUNNER_CLOSE_CODES.unauthorized, 'revoked');
    this.logger.log(`runner ${id} revoked`);
    return toAdminRunner(runner, this.status(runner), runner._count.profiles);
  }

  async ping(id: string): Promise<PingResult> {
    const runner = await this.prisma.runner.findUnique({
      where: { id },
      select: { revokedAt: true },
    });
    if (!runner) throw notFound();
    if (runner.revokedAt) return { status: 'unknown' };
    // D9: only admins reach this route, so the caller's role is admin.
    const result = await this.commands.send(
      id,
      'runner.ping',
      {},
      { role: 'admin', timeoutMs: this.options.pingTimeoutMs },
    );
    if (result.status === 'ok') {
      return { status: 'ok', rttMs: result.rttMs, ts: result.output.ts };
    }
    return result;
  }

  private status(runner: Pick<Runner, 'id' | 'revokedAt'>) {
    const live = this.connections.get(runner.id);
    return deriveStatus(
      { revokedAt: runner.revokedAt, lastBeatAt: live?.lastBeatAt ?? null },
      Date.now(),
      this.options.staleAfterMs,
    );
  }

  /** Invalidates the runner's unused codes and stores the hash of a new one. */
  private async issueCode(
    tx: Tx,
    runnerId: string,
  ): Promise<{ code: string; expiresAt: Date }> {
    await tx.runnerPairingCode.deleteMany({ where: { runnerId, usedAt: null } });
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    await tx.runnerPairingCode.create({
      data: { runnerId, codeHash: hashPairingCode(code), expiresAt },
    });
    return { code, expiresAt };
  }

  /** Retries the transaction on the (astronomically rare) code-hash collision. */
  private async withFreshCode<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(work);
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= ATTEMPTS) throw error;
      }
    }
  }

  private codeResponse(
    runner: Runner,
    code: string,
    expiresAt: Date,
    profilesCount = 0,
  ): PairingCodeResponse {
    return {
      runner: toAdminRunner(runner, this.status(runner), profilesCount),
      pairingCode: code,
      expiresAt: expiresAt.toISOString(),
      command: pairCommand(serverOrigin(), code),
    };
  }
}
