import {
  carryRequiredFrames,
  checkConformance,
  conformanceOf,
  type DesignConformance,
  type DesignFrameDraft,
  type DesignOutput,
  designFrameSlugs,
} from '@nautelle/shared';
import type { Prisma } from '@prisma/client';
import { designTurnWhere } from './design-progress';
import {
  type DesignTurnPlan,
  nextOfBatch,
  repairOf,
  restingStatus,
} from './design-rules';
import {
  type Db,
  type DesignKey,
  designTemplateFor,
  designWhere,
  previousFramesOf,
} from './design-store';

/**
 * #833 D7: whether an off revision gets its automatic repair — not when it
 * is a repair itself, and not when only its step count is over: the turn
 * drew the first steps and the card is to be split, not redrawn.
 */
const wantsRepair = (
  plan: DesignTurnPlan,
  conformance: DesignConformance,
): boolean =>
  !conformance.ok &&
  !plan.repair &&
  (conformance.missing.length > 0 ||
    conformance.extra.length > 0 ||
    conformance.misplaced.length > 0);

/**
 * Applies a design turn (docs/specs/223-design-stage.md D4, D7, D10) inside
 * the turn's settle transaction: the next revision of its variant, the
 * comments it addressed, and the design's status. #441: the revision's
 * frames are stored in the order the turn drew them. Returns the next turn of
 * the batch, if any — the projector starts it once the transaction commits.
 * The design is the turn's owner's: a plan task's or a card's (ADR-0025).
 *
 * #833 (ADR-0082): the revision is checked against the design's template.
 * A revise first gets back every required frame it left out (D10); a
 * revision still off gets one repair turn (D7), which comes before the rest
 * of the batch, and a repair marks the revision it repaired.
 */
export const applyDesignOutput = async (
  tx: Prisma.TransactionClient,
  turn: { id: string; owner: DesignKey },
  plan: DesignTurnPlan,
  output: DesignOutput,
  drawn: readonly DesignFrameDraft[],
): Promise<DesignTurnPlan | null> => {
  const design = await tx.taskDesign.findUnique({
    where: designWhere(turn.owner),
    select: { id: true },
  });
  if (!design) return null;
  const last = await tx.designRevision.findFirst({
    where: { designId: design.id, variant: output.variant },
    orderBy: { revision: 'desc' },
    select: { id: true, revision: true },
  });
  const template = await designTemplateFor(tx, design.id);
  const frames =
    plan.mode === 'revise'
      ? carryRequiredFrames(
          template,
          drawn,
          await previousFramesOf(tx, turn.owner, plan),
        )
      : [...drawn];
  const check = checkConformance(template, frames);
  const conformance = conformanceOf(check);
  const revision = await tx.designRevision.create({
    data: {
      designId: design.id,
      variant: output.variant,
      revision: (last?.revision ?? 0) + 1,
      title: output.title,
      rationale: output.rationale,
      turnId: turn.id,
      templateKey: template.key,
      conformance: conformance as unknown as Prisma.InputJsonValue,
      frames: {
        create: designFrameSlugs(frames.map((f) => f.name)).map(
          (slug, position) => ({
            position,
            name: frames[position].name,
            slug,
            html: frames[position].html,
            kind: frames[position].kind,
            templateFrameKey: check.templateFrameKeys[position],
          }),
        ),
      },
    },
    select: { id: true },
  });
  if (plan.repair && last) {
    await tx.designRevision.update({
      where: { id: last.id },
      data: { repairTurnId: turn.id },
    });
  }
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
  const next = wantsRepair(plan, conformance)
    ? repairOf(plan)
    : nextOfBatch(plan);
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
 * stopped (#275 D2). An approved design is left alone. #840: so is a design
 * with a turn still queued or running — a start the runner did not answer in
 * time may still run it — and the turn's end settles the design.
 */
export const settleDesign = async (db: Db, owner: DesignKey): Promise<void> => {
  const design = await db.taskDesign.findUnique({
    where: designWhere(owner),
    select: { id: true, status: true, _count: { select: { revisions: true } } },
  });
  if (!design || design.status === 'approved') return;
  const active = await db.planTurn.findFirst({
    where: { ...designTurnWhere(owner), phase: { in: ['queued', 'running'] } },
    select: { id: true },
  });
  if (active) return;
  await db.taskDesign.update({
    where: { id: design.id },
    data: {
      status: restingStatus(design._count.revisions > 0),
      busySince: null,
    },
  });
};
