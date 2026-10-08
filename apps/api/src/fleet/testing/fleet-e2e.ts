import type { EventSource, RunnerEvent } from '@agentdock/shared/protocol';
import type { PrismaService } from '../../database/prisma.service';

export const ROOT = '/srv/dev/widget';
export const REPO = 'acme/widget';

/** A runner and a project at `root`, straight in the database. */
export const seedProject = async (
  prisma: PrismaService,
  root = ROOT,
  runnerId?: string,
): Promise<{ runnerId: string; projectId: string }> => {
  const runner =
    runnerId ?? (await prisma.runner.create({ data: { name: 'desk' } })).id;
  const project = await prisma.project.create({
    data: {
      runnerId: runner,
      rootPath: root,
      repo: REPO,
      displayName: root.slice(root.lastIndexOf('/') + 1),
      baseBranch: 'develop',
      baseSource: 'config',
      hasClaudeMd: true,
      hasAgentsMd: false,
      lastInspectedAt: new Date('2026-10-01T00:00:00Z'),
    },
  });
  return { runnerId: runner, projectId: project.id };
};

export interface EventOptions {
  slot?: string;
  issue?: number;
  source?: EventSource;
  root?: string;
}

/**
 * Builds a runner's events with increasing `seq` and `ts` — one second apart
 * from `start` — as a collector would emit them.
 */
export class EventStream {
  private seq = 0;

  constructor(private readonly start = Date.parse('2026-10-08T10:00:00Z')) {}

  next(type: string, data: unknown, options: EventOptions = {}): RunnerEvent {
    this.seq += 1;
    return {
      v: 1,
      seq: this.seq,
      ts: new Date(this.start + this.seq * 1000).toISOString(),
      type,
      source: options.source ?? 'runner',
      project: { repo: REPO, root: options.root ?? ROOT },
      ...(options.slot ? { slot: options.slot } : {}),
      ...(options.issue ? { issue: options.issue } : {}),
      data,
    };
  }

  /** `ts` of the last event built. */
  get lastTs(): string {
    return new Date(this.start + this.seq * 1000).toISOString();
  }
}

/** Every fleet row of the database, in a stable order, for replay comparisons. */
export const fleetRows = async (prisma: PrismaService) => ({
  rounds: await prisma.round.findMany({ orderBy: { id: 'asc' } }),
  slots: await prisma.slot.findMany({ orderBy: { id: 'asc' } }),
  checkpoints: await prisma.slotCheckpoint.findMany({
    orderBy: { id: 'asc' },
  }),
  orchestrators: await prisma.fleetOrchestrator.findMany({
    orderBy: { projectId: 'asc' },
  }),
});
