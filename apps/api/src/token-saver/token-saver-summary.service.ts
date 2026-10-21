import {
  isRunlessKind,
  TOKEN_SAVER_RUN_KINDS,
  TOKEN_SAVER_SUMMARY_MAX_DAYS,
  type TokenSaverBeforeAfter,
  type TokenSaverPromptCache,
  type TokenSaverSummary,
} from '@nautelle/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { runCostsByKind, runPromptCacheByKind } from '../history/run-usage';
import { costPerRoundOfProject } from './cost-per-round';
import {
  byFilterOf,
  cachePricesOfRuns,
  type StatGroup,
  savedOf,
  statGroupsOfProject,
  sum,
  unfilteredProgramsOfProject,
} from './token-saver-facts';

const DAY_MS = 86_400_000;

/** The kinds that have runs; the orchestrator and manual sessions have none (D12, #475). */
const RUN_KINDS = TOKEN_SAVER_RUN_KINDS.filter((k) => !isRunlessKind(k));

const groupBy = <K>(
  groups: readonly StatGroup[],
  key: (g: StatGroup) => K,
): Map<K, StatGroup[]> => {
  const out = new Map<K, StatGroup[]>();
  for (const g of groups) out.set(key(g), [...(out.get(key(g)) ?? []), g]);
  return out;
};

/**
 * `GET /projects/:id/token-saver/summary` (#445 D12, D13): the filter's
 * estimate over a range, and the fact from usage — the average cost of a run
 * launched without the token saver against one launched with it, by kind.
 * #663 D5: and cost per round by session kind and week, the metric the token
 * saver is judged by (ADR-0068).
 */
@Injectable()
export class TokenSaverSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(
    projectId: string,
    fromIso: string,
    toIso: string,
  ): Promise<TokenSaverSummary> {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (from >= to) {
      throw new BadRequestException('from must be before to');
    }
    if (to.getTime() - from.getTime() > TOKEN_SAVER_SUMMARY_MAX_DAYS * DAY_MS) {
      throw new BadRequestException(
        `The range may span at most ${TOKEN_SAVER_SUMMARY_MAX_DAYS} days`,
      );
    }
    const [groups, costs, first, programs, cache, project, perRound] =
      await Promise.all([
        statGroupsOfProject(this.prisma, projectId, from, to),
        runCostsByKind(this.prisma, projectId, RUN_KINDS, from, to),
        this.prisma.tokenSaverStat.findFirst({
          where: { projectId },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        unfilteredProgramsOfProject(this.prisma, projectId, from, to),
        runPromptCacheByKind(this.prisma, projectId, RUN_KINDS, from, to),
        this.prisma.project.findUnique({
          where: { id: projectId },
          select: { runner: { select: { version: true } } },
        }),
        costPerRoundOfProject(this.prisma, projectId, from, to),
      ]);
    const runIds = [
      ...new Set(groups.flatMap((g) => (g.runId === null ? [] : [g.runId]))),
    ];
    const prices = await cachePricesOfRuns(this.prisma, runIds);
    const commands = sum(groups, 'commands');
    const rate = (n: number) => (commands === 0 ? 0 : n / commands);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      pivotAt: first?.createdAt.toISOString() ?? null,
      totals: {
        ...savedOf(groups, prices),
        commands,
        rawBytes: sum(groups, 'rawBytes'),
        keptBytes: sum(groups, 'keptBytes'),
      },
      bypassRate: rate(sum(groups, 'bypassed')),
      passThroughRate: rate(sum(groups, 'passedThrough')),
      beforeAfter: RUN_KINDS.flatMap((runKind): TokenSaverBeforeAfter[] => {
        const side = (on: boolean) =>
          costs.find((c) => c.kind === runKind && c.tokenSaver === on);
        const before = side(false);
        const after = side(true);
        if (!before && !after) return [];
        return [
          {
            runKind,
            beforeRuns: before?.runs ?? 0,
            beforeAvgUsd: before?.avgUsd ?? null,
            afterRuns: after?.runs ?? 0,
            afterAvgUsd: after?.avgUsd ?? null,
          },
        ];
      }),
      byDay: [...groupBy(groups, (g) => g.day)]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, of]) => ({ day, ...savedOf(of, prices) })),
      byFilter: byFilterOf(groups, prices),
      byRunKind: [...groupBy(groups, (g) => g.runKind)]
        .map(([runKind, of]) => ({
          runKind,
          commands: sum(of, 'commands'),
          ...savedOf(of, prices),
        }))
        .sort(
          (a, b) =>
            b.estimateTokens - a.estimateTokens ||
            a.runKind.localeCompare(b.runKind),
        ),
      unfilteredPrograms: programs,
      // RUN_KINDS' order, so the table reads the same on every load.
      promptCache: RUN_KINDS.flatMap((runKind): TokenSaverPromptCache[] => {
        const of = cache.find((c) => c.kind === runKind);
        return of && of.runs > 0
          ? [
              {
                runKind,
                runs: of.runs,
                input: of.input,
                cacheRead: of.cacheRead,
                cacheWrite: of.cacheWrite,
              },
            ]
          : [];
      }),
      runnerVersion: project?.runner.version ?? null,
      costPerRound: perRound,
    };
  }
}
