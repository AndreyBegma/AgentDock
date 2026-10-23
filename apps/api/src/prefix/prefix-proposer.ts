import {
  type FileOverlayPart,
  PREFIX_PROPOSE_MODEL,
  PREFIX_PROPOSE_TIMEOUT_SEC,
} from '@nautelle/shared';
import { prefixProposeArgsSchema } from '@nautelle/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PrefixCommands } from './prefix-commands';
import { PrefixQueues, type ProposeJobData } from './prefix-queues';
import { type PrefixJobOutcome, PrefixRuns } from './prefix-runs';
import { isOpenOverlayConflict } from './rules-compressor';
import { utf8Bytes } from './rules-version';

/**
 * B8: an overlay proposal for one file part. A job sends `prefix.propose` to
 * the project's runner, which reads the file itself (ADR-0001) and refuses a
 * secret-named, `code.deny` or oversized one (`policy_refused`, ADR-0075 §2);
 * the answer is stored as a `proposed` overlay with its original text and
 * hash. At most one open overlay per part: a part with one is skipped.
 */
@Injectable()
export class PrefixProposer {
  private readonly logger = new Logger(PrefixProposer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: PrefixQueues,
    private readonly runs: PrefixRuns,
    private readonly commands: PrefixCommands,
  ) {}

  /** Whether a proposal can be queued on this instance at all. */
  get enabled(): boolean {
    return this.queues.propose !== undefined;
  }

  /** Fire and forget: a failure is logged. */
  request(
    projectId: string,
    part: FileOverlayPart,
    userId: string | null = null,
    auto = false,
  ): void {
    void this.queues
      .addPropose({ projectId, part, userId }, auto)
      .catch((error: unknown) =>
        this.logger.warn(
          `project ${projectId}: proposal for ${part} not queued: ${(error as Error).message}`,
        ),
      );
  }

  async process(data: ProposeJobData): Promise<PrefixJobOutcome> {
    const subject = `project ${data.projectId} ${data.part}`;
    const project = await this.runs.project(data.projectId);
    if (!project) return this.runs.skip(subject, 'no project');
    const open = await this.prisma.prefixOverlay.findFirst({
      where: {
        projectId: project.id,
        part: data.part,
        state: { in: ['proposed', 'approved'] },
      },
      select: { id: true },
    });
    if (open) return this.runs.skip(subject, 'the part has an open overlay');

    const started = await this.runs.start(project, {
      kind: 'prefix_propose',
      name: 'prefix.propose',
      title: `Prefix overlay proposal: ${data.part}`,
      model: PREFIX_PROPOSE_MODEL,
      args: { part: data.part },
      userId: data.userId,
    });
    if (!started.ok) return this.runs.skip(subject, started.why);
    const { runId } = started;
    const args = prefixProposeArgsSchema.parse({
      runId,
      projectId: project.id,
      root: project.rootPath,
      part: data.part,
      sessionId: started.sessionId,
      profileKey: started.profileKey,
      model: PREFIX_PROPOSE_MODEL,
      timeoutSec: PREFIX_PROPOSE_TIMEOUT_SEC,
    });
    const sent = await this.commands
      .propose(project.runnerId, args, started.ctx)
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
      // B8: a refused path ends the run with the runner's `policy_refused`.
      return this.runs.fail(project.id, runId, `runner: ${sent.message}`);
    }
    const { originalSha256, originalText, proposedText } = sent.output;
    if (proposedText.trim() === '') {
      return this.runs.fail(
        project.id,
        runId,
        'contract_violation: the proposal is empty',
      );
    }
    try {
      const overlay = await this.prisma.$transaction(async (tx) => {
        const row = await tx.prefixOverlay.create({
          data: {
            projectId: project.id,
            part: data.part,
            originalSha256,
            originalBytes: utf8Bytes(originalText),
            originalText,
            content: proposedText,
            contentBytes: utf8Bytes(proposedText),
            state: 'proposed',
            runId,
          },
          select: { id: true },
        });
        await this.runs.succeed(tx, project.id, runId);
        return row;
      });
      return { kind: 'stored', runId, overlayId: overlay.id };
    } catch (error) {
      if (isOpenOverlayConflict(error)) {
        return this.runs.fail(
          project.id,
          runId,
          'the part has an open overlay',
        );
      }
      throw error;
    }
  }
}
