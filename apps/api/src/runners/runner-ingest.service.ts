import {
  EVENTS_DUPLICATE_EVENT,
  type HelloMessage,
  pluginEventIdOf,
  type RunnerEvent,
  SPOOL_TRUNCATED_EVENT,
  spoolTruncatedDataSchema,
} from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { advanceCursor, type SeqRange } from './ack-cursor';
import { tokenPrefix, verifyRunnerToken } from './credentials';
import { RunnerEventSinks } from './runner-event-sinks';

const json = (
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === undefined || value === null
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue);

/** What the gateway persists from a runner's socket (spec D5–D7). */
@Injectable()
export class RunnerIngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sinks: RunnerEventSinks,
  ) {}

  /**
   * The runner a token belongs to, or `null` for an unknown, revoked or
   * never-paired one. One argon2 verify at most: the row is found by prefix.
   */
  async authenticate(token: string): Promise<{ id: string } | null> {
    const runner = await this.prisma.runner.findUnique({
      where: { tokenPrefix: tokenPrefix(token) },
      select: { id: true, tokenHash: true, revokedAt: true },
    });
    if (!runner?.tokenHash || runner.revokedAt) return null;
    return (await verifyRunnerToken(runner.tokenHash, token))
      ? { id: runner.id }
      : null;
  }

  /**
   * Records the machine as `hello` describes it and mirrors its profiles (D7).
   * Returns the ack cursor for `welcome`, or `null` when the runner was revoked
   * meanwhile.
   */
  async hello(runnerId: string, hello: HelloMessage): Promise<bigint | null> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.runner.updateMany({
        where: { id: runnerId, revokedAt: null },
        data: {
          hostname: hello.hostname,
          version: hello.runnerVersion,
          protocolVersion: hello.protocolVersion,
          os: hello.os,
          arch: hello.arch,
          capabilities: hello.capabilities as Prisma.InputJsonValue,
          lastSeenAt: new Date(),
        },
      });
      if (updated.count === 0) return null;

      const profiles = hello.capabilities.profiles;
      for (const profile of profiles) {
        const fields = {
          runtime: profile.runtime,
          label: profile.id,
          binary: profile.binary ?? null,
          env: profile.env,
          args: profile.args,
          authenticated: profile.authenticated,
          missing: false,
        };
        await tx.runtimeProfile.upsert({
          where: { runnerId_key: { runnerId, key: profile.id } },
          create: { runnerId, key: profile.id, ...fields },
          update: fields,
        });
      }
      await tx.runtimeProfile.updateMany({
        where: {
          runnerId,
          missing: false,
          key: { notIn: profiles.map((p) => p.id) },
        },
        data: { missing: true },
      });

      const runner = await tx.runner.findUniqueOrThrow({
        where: { id: runnerId },
        select: { ackedSeq: true },
      });
      return runner.ackedSeq;
    });
  }

  async heartbeat(runnerId: string): Promise<void> {
    await this.prisma.runner.update({
      where: { id: runnerId },
      data: { lastSeenAt: new Date() },
    });
  }

  /**
   * Hands a batch to the registered sinks, then stores it — a `(runnerId, seq)`
   * already stored is skipped, so a resend after a reconnect changes nothing
   * (D6) — and returns the new ack cursor. A throwing sink fails the batch
   * before anything is stored: the ack holds and the runner resends it.
   */
  async events(runnerId: string, events: RunnerEvent[]): Promise<bigint> {
    const { fresh, duplicate } = await this.splitPluginDuplicates(events);
    if (fresh.length > 0) await this.sinks.dispatch(runnerId, fresh);
    const row = (event: RunnerEvent) => ({
      runnerId,
      seq: BigInt(event.seq),
      ts: new Date(event.ts),
      type: event.type,
      source: event.source,
      projectRepo: event.project?.repo ?? null,
      projectRoot: event.project?.root ?? null,
      slot: event.slot ?? null,
      issue: event.issue ?? null,
      session: event.session ?? Prisma.DbNull,
    });
    await this.prisma.event.createMany({
      data: [
        ...fresh.map((event) => ({
          ...row(event),
          data: json(event.data),
          pluginEventId: pluginEventIdOf(event),
        })),
        // Its seq is stored so the ack advances; its data is not, so the
        // events table holds each plugin event once (spec 16 D5).
        ...duplicate.map(({ event, pluginEventId }) => ({
          ...row(event),
          type: EVENTS_DUPLICATE_EVENT,
          data: { pluginEventId, type: event.type },
        })),
      ],
      skipDuplicates: true,
    });
    return this.advanceAck(runnerId);
  }

  /**
   * Code Sentinel events the API already has — stored, or earlier in this
   * batch — by `(project root, data.pluginEventId)` (spec 16 D5). A re-read of
   * `events.jsonl` from offset 0 gives them new seqs; without this they would
   * be projected again.
   */
  private async splitPluginDuplicates(events: RunnerEvent[]): Promise<{
    fresh: RunnerEvent[];
    duplicate: { event: RunnerEvent; pluginEventId: string }[];
  }> {
    const key = (root: string, id: string) => `${root}\0${id}`;
    const ids = new Map<string, Set<string>>();
    for (const event of events) {
      const id = pluginEventIdOf(event);
      const root = event.project?.root;
      if (!id || !root) continue;
      ids.set(root, (ids.get(root) ?? new Set()).add(id));
    }
    if (ids.size === 0) return { fresh: events, duplicate: [] };

    const stored = await this.prisma.event.findMany({
      where: {
        OR: [...ids].map(([projectRoot, set]) => ({
          projectRoot,
          pluginEventId: { in: [...set] },
        })),
      },
      select: { projectRoot: true, pluginEventId: true },
    });
    const seen = new Set(
      stored.map((s) => key(s.projectRoot ?? '', s.pluginEventId ?? '')),
    );
    const fresh: RunnerEvent[] = [];
    const duplicate: { event: RunnerEvent; pluginEventId: string }[] = [];
    for (const event of events) {
      const id = pluginEventIdOf(event);
      const root = event.project?.root;
      if (!id || !root) {
        fresh.push(event);
        continue;
      }
      if (seen.has(key(root, id))) {
        duplicate.push({ event, pluginEventId: id });
        continue;
      }
      seen.add(key(root, id));
      fresh.push(event);
    }
    return { fresh, duplicate };
  }

  private async advanceAck(runnerId: string): Promise<bigint> {
    const { ackedSeq } = await this.prisma.runner.findUniqueOrThrow({
      where: { id: runnerId },
      select: { ackedSeq: true },
    });
    const above = { runnerId, seq: { gt: ackedSeq } };
    const [stored, truncations] = await Promise.all([
      this.prisma.event.findMany({ where: above, select: { seq: true } }),
      this.prisma.event.findMany({
        where: { ...above, type: SPOOL_TRUNCATED_EVENT, source: 'runner' },
        select: { data: true },
      }),
    ]);
    const filled: SeqRange[] = stored.map(({ seq }) => [seq, seq]);
    for (const { data } of truncations) {
      const range = spoolTruncatedDataSchema.safeParse(data);
      if (range.success) {
        filled.push([BigInt(range.data.fromSeq), BigInt(range.data.toSeq)]);
      }
    }
    const next = advanceCursor(ackedSeq, filled);
    if (next === ackedSeq) return ackedSeq;
    // GREATEST: a replaced connection finishing late never moves it back.
    const rows = await this.prisma.$queryRaw<{ ackedSeq: bigint }[]>`
      UPDATE runners SET "ackedSeq" = GREATEST("ackedSeq", ${next})
      WHERE id = ${runnerId} RETURNING "ackedSeq"`;
    return rows[0]?.ackedSeq ?? next;
  }
}
