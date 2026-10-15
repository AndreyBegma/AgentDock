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
import { loadDesignProgress } from './design-progress';
import { type DesignKey, designWhere, installedOf } from './design-store';

/**
 * `GET …/tasks/:key/design` once the plan is known readable (D17), and
 * `GET …/board/cards/:number/design` once the project is (#243 D8): the
 * design with its revisions and comments, the skills no longer installed
 * (D15), the viewer's viewports (D11), the design turn under way, and what
 * the busy design is doing or why its last batch failed (#275 D1, D6).
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
  const [installed, settings, progress] = await Promise.all([
    installedOf(prisma, project, row.skills),
    prisma.designSettings.findUnique({
      where: { projectId: project.id },
      select: { viewports: true },
    }),
    loadDesignProgress(prisma, project.id, owner, row),
  ]);
  return toDesignView(row, {
    warnings: skillWarnings(row.skills, installed),
    viewports: settings
      ? viewportsOf(settings.viewports)
      : [...DEFAULT_VIEWPORTS],
    ...progress,
  });
};
