import {
  DEFAULT_VIEWPORTS,
  DESIGN_ERROR,
  type TaskDesignView,
} from '@agentdock/shared';
import type { PrismaService } from '../database/prisma.service';
import { designError } from './design-error';
import {
  designInclude,
  skillWarnings,
  toDesignView,
  viewportsOf,
} from './design-mapper';
import { type DesignKey, designWhere, installedOf } from './design-store';

/** The design turn under way of an owner: its plan task's, or its card's. */
const activeTurnWhere = (owner: DesignKey) =>
  'cardId' in owner
    ? { cardId: owner.cardId }
    : { planId: owner.planId, task: { key: owner.taskKey } };

/**
 * `GET …/tasks/:key/design` once the plan is known readable (D17), and
 * `GET …/board/cards/:number/design` once the project is (#243 D8): the
 * design with its revisions and comments, the skills no longer installed
 * (D15), the viewer's viewports (D11) and the design turn under way.
 */
export const loadDesignView = async (
  prisma: PrismaService,
  project: { id: string; runnerId: string },
  owner: DesignKey,
): Promise<TaskDesignView> => {
  const row = await prisma.taskDesign.findUnique({
    where: designWhere(owner),
    include: designInclude,
  });
  if (!row) {
    throw designError(404, DESIGN_ERROR.notFound, 'Design not found');
  }
  const [installed, settings, active] = await Promise.all([
    installedOf(prisma, project, row.skills),
    prisma.designSettings.findUnique({
      where: { projectId: project.id },
      select: { viewports: true },
    }),
    prisma.planTurn.findFirst({
      where: {
        ...activeTurnWhere(owner),
        action: 'design',
        phase: { in: ['queued', 'running'] },
      },
      select: { id: true },
    }),
  ]);
  return toDesignView(row, {
    warnings: skillWarnings(row.skills, installed),
    viewports: settings
      ? viewportsOf(settings.viewports)
      : [...DEFAULT_VIEWPORTS],
    activeTurnId: active?.id ?? null,
  });
};
