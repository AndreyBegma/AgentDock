import {
  PLANNER_ERROR,
  type PlannerContractVersion,
  type PlanTurnAction,
} from '@agentdock/shared';
import type { Plan, PlanTask } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { type DesignTurnPlan, designTurnPlanOf } from '../design/design-rules';
import {
  loadApprovedDesign,
  loadDesignPrompt,
  profileHasUi,
} from '../design/design-store';
import type { PromptInput } from './plan-prompt';
import { designDirPath, ISSUE_PLACEHOLDER } from './plan-send';
import type { PlanProject } from './plan-store';
import { plannerError } from './planner-error';
import { specDirOf } from './planner-instructions.service';

/**
 * Spec 223: a failed design turn retried — its variant and batch, from its
 * run, and the design back to drawing.
 */
export const retriedDesign = async (
  prisma: PrismaService,
  planId: string,
  runId: string,
  task: PlanTask | null,
): Promise<DesignTurnPlan> => {
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    select: { args: true },
  });
  const design = designTurnPlanOf(run.args);
  if (!design || !task) {
    throw plannerError(
      409,
      PLANNER_ERROR.invalidArgs,
      'The design turn cannot be retried; generate the design again',
    );
  }
  await prisma.taskDesign.updateMany({
    where: { planId, taskKey: task.key },
    data: {
      status: design.mode === 'generate' ? 'generating' : 'revising',
      busySince: new Date(),
    },
  });
  return design;
};

/** The turn whose prompt the design stage adds to. */
export interface DesignTurnSpec {
  action: PlanTurnAction;
  task: PlanTask | null;
  design?: DesignTurnPlan;
}

/**
 * Spec 223: what a turn's prompt carries of the design stage — whether the
 * project has a UI (v2 suggesting turns, D3), a design turn's context (D8),
 * and a write turn's approved design with the path it is published at (D16).
 */
export const designPromptParts = async (
  prisma: PrismaService,
  plan: Plan,
  project: PlanProject,
  spec: DesignTurnSpec,
  contractVersion: PlannerContractVersion,
): Promise<Pick<PromptInput, 'hasUi' | 'design' | 'approvedDesign'>> => {
  if (spec.action === 'design') {
    const design =
      spec.task && spec.design
        ? await prisma.taskDesign.findUnique({
            where: {
              planId_taskKey: { planId: plan.id, taskKey: spec.task.key },
            },
            select: { id: true, variantCount: true, skills: true },
          })
        : null;
    if (!design || !spec.design) {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        'A design turn needs the task design',
      );
    }
    return {
      design: await loadDesignPrompt(prisma, project, design, spec.design),
    };
  }
  if (spec.action === 'write' && spec.task) {
    const approved = await loadApprovedDesign(prisma, plan.id, spec.task.key);
    if (!approved) return {};
    const dir = designDirPath(
      specDirOf(project.codeSentinelConfig),
      ISSUE_PLACEHOLDER,
      spec.task.title,
      approved.variant,
    );
    return {
      approvedDesign: {
        ...approved,
        dir,
        frames: approved.frames.map((f) => ({
          name: f.name,
          path: `${dir}/${f.slug}.html`,
        })),
      },
    };
  }
  if (contractVersion >= 2 && spec.action !== 'clarify') {
    return { hasUi: await profileHasUi(prisma, plan.projectId) };
  }
  return {};
};
