import { type LiveTopic, parseLiveTopic } from '@agentdock/shared';
import type { AuthUser } from '../auth';
import type { PrismaService } from '../database/prisma.service';
import type { TopicVerdict } from '../live/topic-authorizer.registry';
import { readablePlanWhere } from '../planner/plan-access';
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
 * the project, viewer and up — and for a plan turn (#183), only a reader of
 * its plan (`readablePlanWhere`, spec 172 D13). A project the caller cannot
 * see is `forbidden` whether or not it exists; a run that is not a skill run
 * or a plan turn of that project, or a turn of a plan the caller cannot read,
 * is `not_found`, as the planner answers a hidden plan. Re-validation runs
 * this again, so a plan taken back to private drops its other watchers.
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
  const run = await prisma.run.findFirst({
    where: {
      id: runId,
      projectId,
      OR: [
        { kind: 'skill', skillRun: { isNot: null } },
        {
          kind: 'plan',
          planTurn: { is: { plan: readablePlanWhere(user.id) } },
        },
      ],
    },
    select: { id: true },
  });
  return run ? true : 'not_found';
};
