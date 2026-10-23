import {
  DEFAULT_VIEWPORTS,
  DESIGN_ERROR,
  type TaskDesignView,
} from '@nautelle/shared';
import type { PrismaService } from '../database/prisma.service';
import { designError } from './design-error';
import {
  designInclude,
  skillWarnings,
  toDesignView,
  viewportsOf,
} from './design-mapper';
import { loadDesignProgress } from './design-progress';
import {
  type DesignKey,
  designSkillsOf,
  designTemplateFor,
  designWhere,
  installedOf,
} from './design-store';

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
  const [settings, progress, template] = await Promise.all([
    prisma.designSettings.findUnique({
      where: { projectId: project.id },
      select: { viewports: true, defaultSkills: true },
    }),
    loadDesignProgress(prisma, project.id, owner, row),
    designTemplateFor(prisma, row.id),
  ]);
  // #604: a design that follows the default shows today's default.
  const defaultSkills = settings?.defaultSkills ?? [];
  const skills = designSkillsOf(row, row.revisions.length > 0, defaultSkills);
  const installed = await installedOf(prisma, project, skills);
  return toDesignView(row, {
    skills,
    defaultSkills,
    warnings: skillWarnings(skills, installed),
    viewports: settings
      ? viewportsOf(settings.viewports)
      : [...DEFAULT_VIEWPORTS],
    ...progress,
    template,
  });
};
