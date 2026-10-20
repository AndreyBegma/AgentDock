import {
  type DesignFrameDraft,
  type DesignOutput,
  designFrameSlugs,
} from '@nautelle/shared';
import type { Prisma } from '@prisma/client';
import {
  type DesignTurnPlan,
  nextOfBatch,
  restingStatus,
} from './design-rules';
import { type Db, type DesignKey, designWhere } from './design-store';

/**
 * Applies a design turn (docs/specs/223-design-stage.md D4, D7, D10) inside
 * the turn's settle transaction: the next revision of its variant, the
 * comments it addressed, and the design's status. #441: the revision's
 * frames are stored in the order the turn drew them. Returns the next turn of
 * the batch, if any — the projector starts it once the transaction commits.
 * The design is the turn's owner's: a plan task's or a card's (ADR-0025).
 */
export const applyDesignOutput = async (
  tx: Prisma.TransactionClient,
  turn: { id: string; owner: DesignKey },
  plan: DesignTurnPlan,
  output: DesignOutput,
  frames: readonly DesignFrameDraft[],
): Promise<DesignTurnPlan | null> => {
  const design = await tx.taskDesign.findUnique({
    where: designWhere(turn.owner),
    select: { id: true },
  });
  if (!design) return null;
  const last = await tx.designRevision.findFirst({
    where: { designId: design.id, variant: output.variant },
    orderBy: { revision: 'desc' },
    select: { revision: true },
  });
  const revision = await tx.designRevision.create({
    data: {
      designId: design.id,
      variant: output.variant,
      revision: (last?.revision ?? 0) + 1,
      title: output.title,
      rationale: output.rationale,
      turnId: turn.id,
      frames: {
        create: designFrameSlugs(frames.map((f) => f.name)).map(
          (slug, position) => ({
            position,
            name: frames[position].name,
            slug,
            html: frames[position].html,
          }),
        ),
      },
    },
    select: { id: true },
  });
  if (output.addressed.length > 0) {
    // The first revision to list a comment addresses it (D10).
    await tx.designComment.updateMany({
      where: {
        designId: design.id,
        id: { in: output.addressed },
        addressedInRevisionId: null,
      },
      data: { addressedInRevisionId: revision.id },
    });
  }
  const next = nextOfBatch(plan);
  await tx.taskDesign.update({
    where: { id: design.id },
    data: {
      profileId: plan.profileId,
      ...(next ? {} : { status: 'reviewing', busySince: null }),
    },
  });
  return next;
};

/**
 * A design whose turn failed, was cancelled, or never started: back to
 * reviewing what it has, or idle with nothing drawn, its job's clock
 * stopped (#275 D2). An approved design is left alone.
 */
export const settleDesign = async (db: Db, owner: DesignKey): Promise<void> => {
  const design = await db.taskDesign.findUnique({
    where: designWhere(owner),
    select: { id: true, status: true, _count: { select: { revisions: true } } },
  });
  if (!design || design.status === 'approved') return;
  await db.taskDesign.update({
    where: { id: design.id },
    data: {
      status: restingStatus(design._count.revisions > 0),
      busySince: null,
    },
  });
};
