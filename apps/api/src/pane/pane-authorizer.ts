import type { AuthUser } from '../auth';
import type { PrismaService } from '../database/prisma.service';
import type { TopicVerdict } from '../live/topic-authorizer.registry';
import type { ProjectAccessService } from '../projects';
import { parsePaneId } from './pane-topic';

/**
 * Who may watch `pane:<projectId>:<slot>` (spec 18 D6): anyone who can see
 * the project — every member, viewer and up, and admins — and only a slot
 * the project has run. A project the caller cannot see is `forbidden`,
 * whether or not it exists; a slot it has never run is `not_found`. The
 * slot comes from the fleet's `slots` rows, never the filesystem.
 */
export const authorizePane = async (
  access: ProjectAccessService,
  prisma: PrismaService,
  user: AuthUser,
  id: string | null,
): Promise<TopicVerdict> => {
  if (id === null) return false;
  const { projectId, slot } = parsePaneId(id);
  if (!(await access.resolve(user, projectId))) return false;
  const known = await prisma.slot.findFirst({
    where: { projectId, name: slot },
    select: { id: true },
  });
  return known ? true : 'not_found';
};
