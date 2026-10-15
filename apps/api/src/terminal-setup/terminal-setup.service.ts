import {
  profileAgentdockOf,
  type TerminalSetupProfileFacts,
  type TerminalSetupSessionCounts,
  type TerminalSetupView,
  terminalSetup,
  terminalSetupProfileKeys,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import { RunnerPresence } from '../runners/runner-presence';

/** D2, D3: the window sessions and card runs are counted over. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const emptyCounts = (): TerminalSetupSessionCounts => ({
  hooked: 0,
  unhooked: 0,
  unhookedAfterReport: 0,
});

/**
 * The Terminal → Board checklist (#281 D5): the facts from database rows, the
 * runner's stored capabilities and presence — never the project filesystem
 * (ADR-0001) — run through the pure `terminalSetup`.
 */
@Injectable()
export class TerminalSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: RunnerPresence,
  ) {}

  async view(projectId: string): Promise<TerminalSetupView> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        runnerId: true,
        shipSessionContent: true,
        defaultProfile: { select: { key: true } },
        orchestratorSettings: {
          select: { profile: { select: { key: true } } },
        },
        runner: { select: { capabilities: true, lastSeenAt: true } },
      },
    });
    if (!project) throw projectNotFound();
    const since = new Date(Date.now() - WINDOW_MS);
    const [sessionGroups, unhookedLate, cardRuns, settings, profileRows] =
      await Promise.all([
        this.prisma.agentSession.groupBy({
          by: ['profileKey', 'origin'],
          where: {
            projectId,
            origin: { in: ['manual', 'unknown'] },
            startedAt: { gte: since },
          },
          _count: { _all: true },
        }),
        project.runner.lastSeenAt
          ? this.prisma.agentSession.groupBy({
              by: ['profileKey'],
              where: {
                projectId,
                origin: 'unknown',
                startedAt: { gte: since, gt: project.runner.lastSeenAt },
              },
              _count: { _all: true },
            })
          : Promise.resolve([]),
        this.prisma.run.findMany({
          where: { projectId, kind: 'card', startedAt: { gte: since } },
          select: { profileKey: true },
          distinct: ['profileKey'],
        }),
        this.prisma.boardSettings.findUnique({
          where: { projectId },
          select: { captureEnabled: true },
        }),
        this.prisma.runtimeProfile.findMany({
          where: { runnerId: project.runnerId },
          select: { key: true, runtime: true },
        }),
      ]);

    const counts = new Map<string, TerminalSetupSessionCounts>();
    const countsOf = (key: string): TerminalSetupSessionCounts => {
      let entry = counts.get(key);
      if (!entry) {
        entry = emptyCounts();
        counts.set(key, entry);
      }
      return entry;
    };
    for (const group of sessionGroups) {
      if (group.profileKey === null) continue;
      const entry = countsOf(group.profileKey);
      if (group.origin === 'manual') entry.hooked += group._count._all;
      else entry.unhooked += group._count._all;
    }
    for (const group of unhookedLate) {
      if (group.profileKey === null) continue;
      countsOf(group.profileKey).unhookedAfterReport += group._count._all;
    }

    const keys = terminalSetupProfileKeys({
      defaultKey: project.defaultProfile?.key ?? null,
      orchestratorKey: project.orchestratorSettings?.profile?.key ?? null,
      sessionKeys: [...counts.keys()],
      cardRunKeys: cardRuns.map((run) => run.profileKey),
    });
    const runtimes = new Map(profileRows.map((p) => [p.key, p.runtime]));
    const reports = profileAgentdockOf(project.runner.capabilities);
    const profiles: TerminalSetupProfileFacts[] = keys.map((key) => ({
      key,
      runtime: runtimes.get(key) ?? null,
      agentdock: reports[key] ?? null,
      sessions: counts.get(key) ?? emptyCounts(),
    }));

    return terminalSetup({
      projectId,
      runnerConnected: this.presence.isConnected(project.runnerId),
      profiles,
      shipSessionContent: project.shipSessionContent,
      captureEnabled: settings?.captureEnabled ?? false,
    });
  }
}
