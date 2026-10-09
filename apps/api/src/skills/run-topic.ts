import { type LiveTopic, parseLiveTopic } from '@agentdock/shared';
import type { AuthUser } from '../auth';
import type { PrismaService } from '../database/prisma.service';
import type { TopicVerdict } from '../live/topic-authorizer.registry';
import type { ProjectAccessService } from '../projects';

export interface RunTarget {
  projectId: string;
  runId: string;
}

/** The project and run of a `run:` topic id; the topic schema pinned both parts. */
export const parseRunId = (id: string): RunTarget => {
  const colon = id.indexOf(':');
  return { projectId: id.slice(0, colon), runId: id.slice(colon + 1) };
};

export const parseRunTopic = (topic: LiveTopic): RunTarget =>
  parseRunId(parseLiveTopic(topic).id ?? '');

/**
 * Who may read `run:<projectId>:<runId>` (spec 24 D13): anyone who can see
 * the project, viewer and up. A project the caller cannot see is `forbidden`
 * whether or not it exists; a run that is not a skill run of that project is
 * `not_found`.
 */
export const authorizeRun = async (
  access: ProjectAccessService,
  prisma: PrismaService,
  user: AuthUser,
  id: string | null,
): Promise<TopicVerdict> => {
  if (id === null) return false;
  const { projectId, runId } = parseRunId(id);
  if (!(await access.resolve(user, projectId))) return false;
  const run = await prisma.skillRun.findFirst({
    where: { runId, run: { projectId, kind: 'skill' } },
    select: { runId: true },
  });
  return run ? true : 'not_found';
};
