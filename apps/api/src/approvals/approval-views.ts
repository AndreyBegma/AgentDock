import type { ApprovalItemView } from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  type ApprovalPrCache,
  type ApprovalRow,
  type ApprovalSlot,
  toApprovalView,
} from './approvals-mapper';

/**
 * Turns approval rows into views: each PR's latest slot (checks, mergeable,
 * the D3 merge summary) and its title and URL from the issue cache (#19).
 */
@Injectable()
export class ApprovalViews {
  constructor(private readonly prisma: PrismaService) {}

  async views(
    projectId: string,
    rows: ApprovalRow[],
  ): Promise<ApprovalItemView[]> {
    if (rows.length === 0) return [];
    const numbers = [...new Set(rows.map((r) => r.prNumber))];
    const [slots, prs] = await Promise.all([
      this.slots(projectId, numbers),
      this.prs(projectId, numbers),
    ]);
    return rows.map((row) =>
      toApprovalView(
        row,
        slots.get(row.prNumber) ?? null,
        prs.get(row.prNumber) ?? null,
      ),
    );
  }

  async view(projectId: string, row: ApprovalRow): Promise<ApprovalItemView> {
    const [view] = await this.views(projectId, [row]);
    return view;
  }

  /** The latest slot of each PR, with its last `pull request open` checkpoint. */
  private async slots(
    projectId: string,
    numbers: number[],
  ): Promise<Map<number, ApprovalSlot>> {
    const rows = await this.prisma.slot.findMany({
      where: { projectId, prNumber: { in: numbers } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        name: true,
        issue: true,
        prNumber: true,
        prUrl: true,
        prChecks: true,
        prMergeable: true,
        checkpoints: {
          where: { kind: 'pr_open' },
          orderBy: { position: 'desc' },
          take: 1,
          select: { summary: true },
        },
      },
    });
    const byPr = new Map<number, ApprovalSlot>();
    for (const { prNumber, checkpoints, ...slot } of rows) {
      if (prNumber === null || byPr.has(prNumber)) continue;
      const summary = checkpoints[0]?.summary.trim();
      byPr.set(prNumber, { ...slot, summary: summary ? summary : null });
    }
    return byPr;
  }

  private async prs(
    projectId: string,
    numbers: number[],
  ): Promise<Map<number, ApprovalPrCache>> {
    const rows = await this.prisma.issueCache.findMany({
      where: { projectId, kind: 'pull_request', number: { in: numbers } },
      select: { number: true, title: true, url: true },
    });
    return new Map(rows.map((r) => [r.number, { title: r.title, url: r.url }]));
  }
}
