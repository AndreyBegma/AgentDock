import {
  profileAgentdockOf,
  reportedClaudeProfileKeysOf,
  TERMINAL_SETUP_USE_WINDOW_DAYS,
  type TerminalSetupProfileFacts,
  type TerminalSetupSessionCounts,
  type TerminalSetupView,
  terminalSetup,
  terminalSetupProfileKeys,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import { RunnerPresence } from '../runners/runner-presence';

const DAY_MS = 24 * 60 * 60 * 1000;

/** D2: the window sessions are counted over. */
const WINDOW_MS = 7 * DAY_MS;

/** #719: the window a session or card run makes a profile one the project uses. */
const USE_WINDOW_MS = TERMINAL_SETUP_USE_WINDOW_DAYS * DAY_MS;

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
    private readonly audit: AuditService,
  ) {}

  /**
   * #719: hide a profile from Nautelle on the project's runner, or show it
   * again — every project on that runner. Kept by the server only: the
   * runner's local policy and `nautelle-runner profiles` are unchanged.
   */
  async setIgnored(
    projectId: string,
    profileKey: string,
    ignored: boolean,
    ctx: AuditContext,
  ): Promise<TerminalSetupView> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        runnerId: true,
        runner: { select: { ignoredProfileKeys: true } },
      },
    });
    if (!project) throw projectNotFound();
    const before = project.runner.ignoredProfileKeys;
    const after = ignored
      ? [...new Set([...before, profileKey])]
      : before.filter((key) => key !== profileKey);
    if (after.length !== before.length) {
      await this.prisma.runner.update({
        where: { id: project.runnerId },
        data: { ignoredProfileKeys: after },
      });
      await this.audit.record({
        ...ctx,
        action: 'runner.update',
        target: { type: 'runner', id: project.runnerId },
        projectId,
        before: { ignoredProfileKeys: before },
        after: { ignoredProfileKeys: after },
        result: 'ok',
      });
    }
    return this.view(projectId);
  }

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
        runner: {
          select: {
            capabilities: true,
            lastSeenAt: true,
            ignoredProfileKeys: true,
          },
        },
      },
    });
    if (!project) throw projectNotFound();
    const since = new Date(Date.now() - WINDOW_MS);
    const usedSince = new Date(Date.now() - USE_WINDOW_MS);
    const [
      sessionGroups,
      unhookedLate,
      usedSessions,
      cardRuns,
      settings,
      profileRows,
    ] = await Promise.all([
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
      this.prisma.agentSession.findMany({
        where: {
          projectId,
          origin: { in: ['manual', 'unknown'] },
          startedAt: { gte: usedSince },
        },
        select: { profileKey: true },
        distinct: ['profileKey'],
      }),
      this.prisma.run.findMany({
        where: { projectId, kind: 'card', startedAt: { gte: usedSince } },
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

    const ignoredProfileKeys = project.runner.ignoredProfileKeys;
    const keys = terminalSetupProfileKeys({
      defaultKey: project.defaultProfile?.key ?? null,
      orchestratorKey: project.orchestratorSettings?.profile?.key ?? null,
      sessionKeys: usedSessions.map((row) => row.profileKey),
      cardRunKeys: cardRuns.map((run) => run.profileKey),
      reportedKeys: reportedClaudeProfileKeysOf(project.runner.capabilities),
      ignoredKeys: ignoredProfileKeys,
    });
    const runtimes = new Map(profileRows.map((p) => [p.key, p.runtime]));
    const reports = profileAgentdockOf(project.runner.capabilities);
    const factsOf = (key: string): TerminalSetupProfileFacts => ({
      key,
      runtime: runtimes.get(key) ?? null,
      agentdock: reports[key] ?? null,
      sessions: counts.get(key) ?? emptyCounts(),
    });

    return terminalSetup({
      projectId,
      runnerConnected: this.presence.isConnected(project.runnerId),
      profiles: keys.used.map(factsOf),
      otherProfiles: keys.other.map(factsOf),
      ignoredProfileKeys,
      shipSessionContent: project.shipSessionContent,
      captureEnabled: settings?.captureEnabled ?? false,
    });
  }
}
