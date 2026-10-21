import {
  type FileOverlayPart,
  overlayPartOf,
  PREFIX_BUDGET_DEFAULT_TOKENS,
  type PrefixLaunchKindView,
  type PrefixOrigin,
  type PrefixPartKind,
  type PrefixSummaryView,
  type PrefixTopPartView,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RUN_REQUESTS } from '../history/run-usage';

/** B3: the top parts by ≈tokens × launches. */
export const PREFIX_TOP_PARTS = 10;

/** The median of the values; null for none. */
export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? null)
    : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
};

interface MeasuredRun {
  runId: string;
  launchKind: string;
  estTokens: number;
  prefixTokens: number | null;
}

/**
 * The Token saver page's Prefix section (#751 B2, B3). The measured fact is a
 * run's first-turn input (input + cache read + cache write of its first main
 * request), filled into `runs.prefixTokens` once the request is known; until
 * then a run counts by its parts' ≈tokens. A launch kind is over budget when
 * its median — measured where it can be — exceeds `prefixBudgetTokens`.
 */
@Injectable()
export class PrefixSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async budgetOf(projectId: string): Promise<number> {
    const row = await this.prisma.tokenSaverSettings.findUnique({
      where: { projectId },
      select: { prefixBudgetTokens: true },
    });
    return row?.prefixBudgetTokens ?? PREFIX_BUDGET_DEFAULT_TOKENS;
  }

  async summary(
    projectId: string,
    from: string,
    to: string,
  ): Promise<PrefixSummaryView> {
    const range = { gte: new Date(from), lt: new Date(to) };
    const runs = await this.measuredRuns(projectId, range);
    const budgetTokens = await this.budgetOf(projectId);
    return {
      from,
      to,
      budgetTokens,
      kinds: kindsOf(runs, budgetTokens),
      topParts: await this.topParts(projectId, range),
    };
  }

  /**
   * QB2: the over-budget launch kind's largest `repo` part that an overlay
   * can replace — over the runs of the last `days` days. Null when the kind
   * is within budget or has no such part.
   */
  async overBudgetPart(
    projectId: string,
    launchKind: string,
    days = 7,
  ): Promise<FileOverlayPart | null> {
    const range = { gte: new Date(Date.now() - days * 86_400_000) };
    const runs = (await this.measuredRuns(projectId, range)).filter(
      (r) => r.launchKind === launchKind,
    );
    const budget = await this.budgetOf(projectId);
    const kind = kindsOf(runs, budget)[0];
    if (!kind?.overBudget) return null;
    const parts = await this.prisma.runPrefixPart.findMany({
      where: { projectId, launchKind, origin: 'repo', createdAt: range },
      orderBy: [{ estTokens: 'desc' }, { createdAt: 'desc' }],
      select: { kind: true, name: true, path: true, origin: true },
      take: 50,
    });
    for (const part of parts) {
      const overlay = overlayPartOf(part);
      if (overlay) return overlay;
    }
    return null;
  }

  private async measuredRuns(
    projectId: string,
    createdAt: Prisma.DateTimeFilter,
  ): Promise<MeasuredRun[]> {
    const grouped = await this.prisma.runPrefixPart.groupBy({
      by: ['runId', 'launchKind'],
      where: { projectId, createdAt },
      _sum: { estTokens: true },
    });
    if (grouped.length === 0) return [];
    const ids = grouped.map((g) => g.runId);
    await this.fillPrefixTokens(ids);
    const facts = new Map(
      (
        await this.prisma.run.findMany({
          where: { id: { in: ids } },
          select: { id: true, prefixTokens: true },
        })
      ).map((r) => [r.id, r.prefixTokens]),
    );
    return grouped.map((g) => ({
      runId: g.runId,
      launchKind: g.launchKind,
      estTokens: g._sum.estTokens ?? 0,
      prefixTokens: facts.get(g.runId) ?? null,
    }));
  }

  /**
   * B2: `runs.prefixTokens` of the given runs that have none yet, from each
   * run's first main request. A run without a request stays null.
   */
  async fillPrefixTokens(runIds: readonly string[]): Promise<void> {
    if (runIds.length === 0) return;
    const ids = Prisma.join(runIds);
    const rows = await this.prisma.$queryRaw<
      { runId: string; tokens: number }[]
    >`
      SELECT DISTINCT ON (r.id) r.id AS "runId",
        (l.input + l."cacheRead" + l."cacheWrite5m" + l."cacheWrite1h")::int AS tokens
      ${RUN_REQUESTS}
      WHERE r.id IN (${ids}) AND r."prefixTokens" IS NULL
        AND l."querySource" = 'main'
      ORDER BY r.id, l.ts ASC`;
    for (const row of rows) {
      await this.prisma.run.updateMany({
        where: { id: row.runId, prefixTokens: null },
        data: { prefixTokens: row.tokens },
      });
    }
  }

  private async topParts(
    projectId: string,
    createdAt: Prisma.DateTimeFilter,
  ): Promise<PrefixTopPartView[]> {
    const rows = await this.prisma.runPrefixPart.findMany({
      where: { projectId, createdAt },
      orderBy: { createdAt: 'desc' },
      select: {
        kind: true,
        name: true,
        path: true,
        origin: true,
        estTokens: true,
      },
    });
    const parts = new Map<
      string,
      Omit<PrefixTopPartView, 'overlay' | 'overlayPart'> & { weight: number }
    >();
    for (const row of rows) {
      const key = `${row.kind}\u0000${row.name}\u0000${row.path}`;
      const known = parts.get(key);
      if (known) {
        known.launches += 1;
        known.weight += row.estTokens;
      } else {
        // Newest first: the first row seen is the latest size.
        parts.set(key, {
          kind: row.kind as PrefixPartKind,
          name: row.name,
          path: row.path,
          origin: row.origin as PrefixOrigin,
          estTokens: row.estTokens,
          launches: 1,
          weight: row.estTokens,
        });
      }
    }
    const top = [...parts.values()]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, PREFIX_TOP_PARTS);
    const overlays = await this.prisma.prefixOverlay.findMany({
      where: { projectId, state: { in: ['proposed', 'approved', 'stale'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, part: true, state: true },
    });
    return top.map(({ weight: _weight, ...part }) => {
      const overlayPart = overlayPartOf(part);
      const open =
        overlays.find(
          (o) =>
            o.part === overlayPart &&
            (o.state === 'proposed' || o.state === 'approved'),
        ) ?? overlays.find((o) => o.part === overlayPart);
      return {
        ...part,
        overlayPart,
        overlay: open ? { id: open.id, state: open.state } : null,
      };
    });
  }
}

/** B3: per launch kind, the median prefix and the budget flag. */
export const kindsOf = (
  runs: readonly MeasuredRun[],
  budgetTokens: number,
): PrefixLaunchKindView[] => {
  const byKind = new Map<string, MeasuredRun[]>();
  for (const run of runs) {
    byKind.set(run.launchKind, [...(byKind.get(run.launchKind) ?? []), run]);
  }
  return [...byKind.entries()]
    .map(([launchKind, rows]) => {
      const measured = median(
        rows.flatMap((r) => (r.prefixTokens === null ? [] : [r.prefixTokens])),
      );
      const estimated = median(rows.map((r) => r.estTokens)) ?? 0;
      return {
        launchKind,
        launches: rows.length,
        medianTokens: measured,
        medianEstTokens: estimated,
        overBudget: (measured ?? estimated) > budgetTokens,
      };
    })
    .sort((a, b) => b.launches - a.launches);
};
