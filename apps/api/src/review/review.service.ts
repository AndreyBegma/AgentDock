import {
  type CreateReviewStepRequest,
  PEER_REVIEW_STEP_NAME,
  REVIEW_ERROR,
  REVIEW_STEPS_MAX,
  type ReviewGenerationError,
  type ReviewSettingsUpdateResult,
  type ReviewSettingsView,
  type ReviewStepView,
  type UpdateReviewSettingsRequest,
  type UpdateReviewStepRequest,
} from '@nautelle/shared';
import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, type ProjectReviewStep } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { SkillInventoryService } from '../skills/skill-inventory.service';
import {
  DEFAULT_PEER_REVIEW_INSTRUCTIONS,
  type PeerReviewActor,
  PeerReviewGenerator,
} from './peer-review-generator';
import { reviewError, reviewStepNotFound } from './review-error';

export const reviewStepView = (row: ProjectReviewStep): ReviewStepView => ({
  id: row.id,
  projectId: row.projectId,
  position: row.position,
  enabled: row.enabled,
  name: row.name,
  type: row.type,
  instructions: row.instructions,
  skillName: row.skillName,
  instructionsGeneratedAt: row.instructionsGeneratedAt?.toISOString() ?? null,
  instructionsEditedAt: row.instructionsEditedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** What the audit log keeps of a step; never the instructions themselves. */
const audited = (row: ProjectReviewStep) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  enabled: row.enabled,
  position: row.position,
  skillName: row.skillName,
});

const ORDER = [{ position: 'asc' }, { createdAt: 'asc' }] as const;

/** The partial unique index `project_review_steps_peer_review_key`. */
const isPeerReviewConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/** The code and message of a typed HTTP error, for `generationError`. */
const generationErrorOf = (error: HttpException): ReviewGenerationError => {
  const body = error.getResponse();
  if (typeof body === 'object' && body !== null) {
    const { error: code, message } = body as {
      error?: unknown;
      message?: unknown;
    };
    return {
      code: typeof code === 'string' ? code : 'generation_failed',
      message: typeof message === 'string' ? message : error.message,
    };
  }
  return { code: 'generation_failed', message: error.message };
};

/**
 * A project's review configuration (#862, ADR-0084): the two switches on its
 * board settings and its ordered review steps. Any member reads it; a
 * project admin writes it. One `peer_review` step exists per project from
 * the first time review is turned on — it can be disabled, never deleted —
 * and `skill` steps name a skill the project's runner reports. Positions stay
 * dense and 0-based. Every write is audited as a `project.update`.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly generator: PeerReviewGenerator,
    private readonly skills: SkillInventoryService,
  ) {}

  async view(projectId: string): Promise<ReviewSettingsView> {
    const [settings, steps] = await Promise.all([
      this.prisma.boardSettings.findUnique({
        where: { projectId },
        select: { reviewEnabled: true, publishReviewComments: true },
      }),
      this.steps(projectId),
    ]);
    return {
      projectId,
      reviewEnabled: settings?.reviewEnabled ?? false,
      publishReviewComments: settings?.publishReviewComments ?? false,
      steps,
    };
  }

  /**
   * Turning review on the first time creates the peer review step with
   * generated instructions; a failed generation stores the built-in default
   * and says why in `generationError`. A step that exists is left as it is.
   */
  async updateSettings(
    projectId: string,
    input: UpdateReviewSettingsRequest,
    actor: PeerReviewActor,
  ): Promise<ReviewSettingsUpdateResult> {
    const before = await this.view(projectId);
    let generationError: ReviewGenerationError | null = null;
    if (input.reviewEnabled === true && !(await this.peerReview(projectId))) {
      generationError = await this.createPeerReview(projectId, actor);
    }

    const data = {
      ...(input.reviewEnabled !== undefined
        ? { reviewEnabled: input.reviewEnabled }
        : {}),
      ...(input.publishReviewComments !== undefined
        ? { publishReviewComments: input.publishReviewComments }
        : {}),
    };
    if (Object.keys(data).length > 0) {
      await this.prisma.boardSettings.upsert({
        where: { projectId },
        create: { projectId, ...data },
        update: data,
      });
    }
    const after = await this.view(projectId);
    await this.record(
      projectId,
      actor.ctx,
      {
        reviewEnabled: before.reviewEnabled,
        publishReviewComments: before.publishReviewComments,
      },
      {
        reviewEnabled: after.reviewEnabled,
        publishReviewComments: after.publishReviewComments,
      },
      'settings',
      generationError ? { generationError: generationError.code } : {},
    );
    return { ...after, generationError };
  }

  /** A `skill` step, appended last; the skill must be one the runner reports. */
  async createStep(
    projectId: string,
    input: CreateReviewStepRequest,
    ctx: AuditContext,
  ): Promise<ReviewStepView> {
    await this.assertSkill(projectId, input.skillName);
    const count = await this.prisma.projectReviewStep.count({
      where: { projectId },
    });
    if (count >= REVIEW_STEPS_MAX) {
      throw reviewError(
        409,
        REVIEW_ERROR.tooManySteps,
        `A project has at most ${REVIEW_STEPS_MAX} review steps`,
      );
    }
    const row = await this.prisma.projectReviewStep.create({
      data: {
        projectId,
        type: 'skill',
        name: input.name,
        skillName: input.skillName,
        enabled: input.enabled ?? true,
        position: await this.nextPosition(projectId),
      },
    });
    await this.record(projectId, ctx, {}, { step: audited(row) }, 'create');
    return reviewStepView(row);
  }

  /**
   * Only the fields given change. `instructions` belongs to the peer review
   * step and is stored exactly as sent; `skillName` belongs to a skill step.
   */
  async updateStep(
    projectId: string,
    stepId: string,
    input: UpdateReviewStepRequest,
    ctx: AuditContext,
  ): Promise<ReviewStepView> {
    const before = await this.find(projectId, stepId);
    if (input.instructions !== undefined && before.type !== 'peer_review') {
      throw reviewError(
        400,
        REVIEW_ERROR.wrongType,
        'Only the peer review step has instructions',
      );
    }
    if (input.skillName !== undefined) {
      if (before.type !== 'skill') {
        throw reviewError(
          400,
          REVIEW_ERROR.wrongType,
          'Only a skill step names a skill',
        );
      }
      await this.assertSkill(projectId, input.skillName);
    }
    const row = await this.prisma.projectReviewStep.update({
      where: { id: before.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.skillName !== undefined
          ? { skillName: input.skillName }
          : {}),
        ...(input.instructions !== undefined
          ? {
              instructions: input.instructions,
              instructionsEditedAt: new Date(),
            }
          : {}),
      },
    });
    await this.record(
      projectId,
      ctx,
      { step: audited(before) },
      { step: audited(row) },
      'update',
      input.instructions !== undefined ? { instructions: 'edited' } : {},
    );
    return reviewStepView(row);
  }

  /** The peer review step cannot be deleted (409); disable it instead. */
  async removeStep(
    projectId: string,
    stepId: string,
    ctx: AuditContext,
  ): Promise<void> {
    const step = await this.find(projectId, stepId);
    if (step.type === 'peer_review') {
      throw reviewError(
        409,
        REVIEW_ERROR.builtinStep,
        'The peer review step cannot be deleted; disable it instead',
      );
    }
    await this.prisma.$transaction([
      this.prisma.projectReviewStep.delete({ where: { id: step.id } }),
      this.prisma.projectReviewStep.updateMany({
        where: { projectId, position: { gt: step.position } },
        data: { position: { decrement: 1 } },
      }),
    ]);
    await this.record(projectId, ctx, { step: audited(step) }, {}, 'delete');
  }

  /** `stepIds` must name every step of the project exactly once. */
  async reorder(
    projectId: string,
    stepIds: readonly string[],
    ctx: AuditContext,
  ): Promise<ReviewStepView[]> {
    const current = await this.prisma.projectReviewStep.findMany({
      where: { projectId },
      orderBy: [...ORDER],
      select: { id: true },
    });
    const known = new Set(current.map((s) => s.id));
    const exact =
      stepIds.length === known.size &&
      new Set(stepIds).size === stepIds.length &&
      stepIds.every((id) => known.has(id));
    if (!exact) {
      throw reviewError(
        409,
        REVIEW_ERROR.orderMismatch,
        'The order must list every review step of the project exactly once',
      );
    }
    await this.prisma.$transaction(
      stepIds.map((id, position) =>
        this.prisma.projectReviewStep.update({
          where: { id },
          data: { position },
        }),
      ),
    );
    await this.record(
      projectId,
      ctx,
      { stepOrder: current.map((s) => s.id) },
      { stepOrder: [...stepIds] },
      'reorder',
    );
    return this.steps(projectId);
  }

  /**
   * Replaces the peer review instructions with freshly generated ones,
   * edits included. A failed generation changes nothing.
   */
  async regenerate(
    projectId: string,
    actor: PeerReviewActor,
  ): Promise<ReviewStepView> {
    const step = await this.peerReview(projectId);
    if (!step) {
      throw reviewError(
        409,
        REVIEW_ERROR.noPeerReview,
        'Turn review on first; that creates the peer review step',
      );
    }
    const instructions = await this.generator.generate(projectId, actor);
    const row = await this.prisma.projectReviewStep.update({
      where: { id: step.id },
      data: { instructions, instructionsGeneratedAt: new Date() },
    });
    await this.record(
      projectId,
      actor.ctx,
      { step: audited(step) },
      { step: audited(row) },
      'regenerate',
    );
    return reviewStepView(row);
  }

  private async steps(projectId: string): Promise<ReviewStepView[]> {
    const rows = await this.prisma.projectReviewStep.findMany({
      where: { projectId },
      orderBy: [...ORDER],
    });
    return rows.map(reviewStepView);
  }

  private peerReview(projectId: string): Promise<ProjectReviewStep | null> {
    return this.prisma.projectReviewStep.findFirst({
      where: { projectId, type: 'peer_review' },
    });
  }

  /**
   * The peer review step, first in the order. Generation runs outside the
   * transaction; when a concurrent enable created the step meanwhile, the
   * unique index refuses this one and that step is kept.
   */
  private async createPeerReview(
    projectId: string,
    actor: PeerReviewActor,
  ): Promise<ReviewGenerationError | null> {
    let instructions = DEFAULT_PEER_REVIEW_INSTRUCTIONS;
    let instructionsGeneratedAt: Date | null = null;
    let generationError: ReviewGenerationError | null = null;
    try {
      instructions = await this.generator.generate(projectId, actor);
      instructionsGeneratedAt = new Date();
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      generationError = generationErrorOf(error);
    }
    try {
      await this.prisma.$transaction([
        this.prisma.projectReviewStep.updateMany({
          where: { projectId },
          data: { position: { increment: 1 } },
        }),
        this.prisma.projectReviewStep.create({
          data: {
            projectId,
            type: 'peer_review',
            name: PEER_REVIEW_STEP_NAME,
            position: 0,
            instructions,
            instructionsGeneratedAt,
          },
        }),
      ]);
    } catch (error) {
      if (isPeerReviewConflict(error)) return null;
      throw error;
    }
    return generationError;
  }

  private async assertSkill(projectId: string, skillName: string) {
    const project = await this.skills.project(projectId);
    if (!(await this.skills.has(project, skillName))) {
      throw reviewError(
        400,
        REVIEW_ERROR.unknownSkill,
        `The project's runner does not report a skill "${skillName}"; rescan its skills if it was just installed`,
      );
    }
  }

  /** A step of `projectId`; another project's step is not found. */
  private async find(
    projectId: string,
    stepId: string,
  ): Promise<ProjectReviewStep> {
    const step = await this.prisma.projectReviewStep.findFirst({
      where: { id: stepId, projectId },
    });
    if (!step) throw reviewStepNotFound();
    return step;
  }

  private async nextPosition(projectId: string): Promise<number> {
    const last = await this.prisma.projectReviewStep.aggregate({
      where: { projectId },
      _max: { position: true },
    });
    return (last._max.position ?? -1) + 1;
  }

  private record(
    projectId: string,
    ctx: AuditContext,
    before: object,
    after: object,
    change: string,
    meta: object = {},
  ): Promise<void> {
    return this.audit.record({
      ...ctx,
      action: 'project.update',
      target: { type: 'project', id: projectId },
      projectId,
      before,
      after,
      result: 'ok',
      meta: { review: change, ...meta },
    });
  }
}
