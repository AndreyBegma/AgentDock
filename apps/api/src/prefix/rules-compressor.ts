import {
  OVERLAY_PART_RULES,
  RULES_COMPRESS_MODEL,
  RULES_COMPRESS_TIMEOUT_SEC,
} from '@nautelle/shared';
import { rulesCompressArgsSchema } from '@nautelle/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PrefixCommands } from './prefix-commands';
import { type CompressJobData, PrefixQueues } from './prefix-queues';
import { type PrefixJobOutcome, PrefixRuns } from './prefix-runs';
import {
  buildCompressPrompt,
  parseCompressAnswer,
  renderedRules,
} from './rules-compress-input';
import { enabledRules, sha256Of, utf8Bytes } from './rules-version';

/** The partial unique index on open overlays (migration `…14`). */
export const isOpenOverlayConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/**
 * B6: the injected rules, compressed with haiku once per rules version. A
 * rules write requests it (`request`); a debounced job (`process`) sends
 * `rules.compress` when the version it was asked for is still current and has
 * no compression yet. The answer is stored as a `proposed` `rules` overlay
 * for a project admin to approve (B9); an open one of an older version goes
 * `stale`. It never fails the rules write.
 */
@Injectable()
export class RulesCompressor {
  private readonly logger = new Logger(RulesCompressor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: PrefixQueues,
    private readonly runs: PrefixRuns,
    private readonly commands: PrefixCommands,
  ) {}

  /** Fire and forget: a failure is logged, the rules write is unaffected. */
  request(projectId: string, userId: string | null = null): void {
    void this.enqueue(projectId, userId).catch((error: unknown) =>
      this.logger.warn(
        `project ${projectId}: rules compression not queued: ${(error as Error).message}`,
      ),
    );
  }

  async enqueue(projectId: string, userId: string | null): Promise<void> {
    const { rules, version } = await enabledRules(this.prisma, projectId);
    if (rules.length === 0) return;
    await this.queues.addCompress({ projectId, rulesVersion: version, userId });
  }

  async process(data: CompressJobData): Promise<PrefixJobOutcome> {
    const subject = `project ${data.projectId} rules ${data.rulesVersion.slice(0, 12)}`;
    const project = await this.runs.project(data.projectId);
    if (!project) return this.runs.skip(subject, 'no project');
    const { rules, version } = await enabledRules(this.prisma, project.id);
    if (version !== data.rulesVersion) {
      return this.runs.skip(subject, 'the rules changed since');
    }
    if (rules.length === 0) return this.runs.skip(subject, 'no enabled rule');
    const done = await this.prisma.prefixOverlay.findFirst({
      where: {
        projectId: project.id,
        part: OVERLAY_PART_RULES,
        rulesVersion: version,
      },
      select: { id: true },
    });
    if (done) return this.runs.skip(subject, 'this version is compressed');

    const started = await this.runs.start(project, {
      kind: 'rules_compress',
      name: 'rules.compress',
      title: 'Rules compression',
      model: RULES_COMPRESS_MODEL,
      args: { rulesVersion: version, rules: rules.length },
      userId: data.userId,
    });
    if (!started.ok) return this.runs.skip(subject, started.why);
    const { runId } = started;
    const args = rulesCompressArgsSchema.safeParse({
      runId,
      projectId: project.id,
      sessionId: started.sessionId,
      prompt: buildCompressPrompt(rules),
      profileKey: started.profileKey,
      model: RULES_COMPRESS_MODEL,
      timeoutSec: RULES_COMPRESS_TIMEOUT_SEC,
    });
    if (!args.success) {
      return this.runs.fail(project.id, runId, 'the rules are too large');
    }
    const sent = await this.commands
      .compress(project.runnerId, args.data, started.ctx)
      .catch((error: unknown) => ({
        status: 'error' as const,
        code: 'internal',
        message: (error as Error).message,
      }));
    if (sent.status === 'unknown') {
      return this.runs.fail(
        project.id,
        runId,
        'the runner did not answer in time',
      );
    }
    if (sent.status === 'error') {
      return this.runs.fail(project.id, runId, `runner: ${sent.message}`);
    }
    if (sent.output.resultTruncated) {
      return this.runs.fail(
        project.id,
        runId,
        'contract_violation: result_truncated: the answer was cut',
      );
    }
    const parsed = parseCompressAnswer(sent.output.resultText, rules);
    if (!parsed.ok) {
      return this.runs.fail(
        project.id,
        runId,
        `contract_violation: ${parsed.message}`,
      );
    }

    const original = renderedRules(rules);
    const compressed = renderedRules(parsed.compressed.rules);
    try {
      const overlay = await this.prisma.$transaction(async (tx) => {
        // An open compression of an older version can never apply again.
        await tx.prefixOverlay.updateMany({
          where: {
            projectId: project.id,
            part: OVERLAY_PART_RULES,
            state: { in: ['proposed', 'approved'] },
            NOT: { rulesVersion: version },
          },
          data: { state: 'stale' },
        });
        const row = await tx.prefixOverlay.create({
          data: {
            projectId: project.id,
            part: OVERLAY_PART_RULES,
            originalSha256: sha256Of(original),
            originalBytes: utf8Bytes(original),
            originalText: original,
            content: JSON.stringify(parsed.compressed),
            contentBytes: utf8Bytes(compressed),
            state: 'proposed',
            runId,
            rulesVersion: version,
          },
          select: { id: true },
        });
        await this.runs.succeed(tx, project.id, runId);
        return row;
      });
      return { kind: 'stored', runId, overlayId: overlay.id };
    } catch (error) {
      if (isOpenOverlayConflict(error)) {
        return this.runs.fail(project.id, runId, 'another compression is open');
      }
      throw error;
    }
  }
}
