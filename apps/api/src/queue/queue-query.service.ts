import {
  boardVerdicts,
  comparePriority,
  heldForLead,
  priorityOf,
  QUEUE_ERROR,
  QUEUE_HISTORY_ROUNDS,
  type OpenIssueView,
  type QueueBlocker,
  type QueueHistoryEntry,
  type QueueIssueDetail,
  type QueueItemView,
  type QueueState,
  type QueueVerdict,
  type QueueView,
  type WaveSlot,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import {
  assigneesOf,
  decisionsOf,
  type IssueRow,
  labelsOf,
  latestRound,
  readyLabelOf,
} from './queue-inputs';
import { queueError } from './queue-error';

type StateRow = Prisma.QueueStateRowGetPayload<object>;

export interface QueueListOptions {
  state?: QueueState;
  /** Also list open issues without the ready label. */
  includeOpen?: boolean;
}

const formatDate = (date: Date): string => date.toISOString().slice(0, 10);

const waveSlotsOf = (value: Prisma.JsonValue): WaveSlot[] | null =>
  Array.isArray(value)
    ? value.flatMap((v) =>
        v && typeof v === 'object' && !Array.isArray(v) && typeof v.slot === 'string'
          ? [
              {
                slot: v.slot,
                lead: v.lead === true,
                model: typeof v.model === 'string' ? v.model : null,
              },
            ]
          : [],
      )
    : null;

const numbersOf = (value: Prisma.JsonValue): number[] =>
  Array.isArray(value)
    ? value.filter((v): v is number => typeof v === 'number')
    : [];

const orchestratorOf = (row: StateRow): QueueVerdict | null =>
  row.orchestratorState
    ? {
        state: row.orchestratorState,
        why: row.orchestratorWhy ?? '',
        clears: row.orchestratorClears,
      }
    : null;

/** Reads the queue (spec 19 "API"); it never writes. */
@Injectable()
export class QueueQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async queue(
    projectId: string,
    options: QueueListOptions = {},
  ): Promise<QueueView> {
    const project = await this.project(projectId);
    const [feed, states, round] = await Promise.all([
      this.prisma.issueFeed.findUnique({ where: { projectId } }),
      this.prisma.queueStateRow.findMany({ where: { projectId } }),
      latestRound(this.prisma, projectId),
    ]);
    const issues = await this.issues(projectId, states);
    const items = states
      .flatMap((row) => {
        const issue = issues.get(row.issueNumber);
        return issue ? [this.item(project.repo, row, issue, issues)] : [];
      })
      .filter((item) => !options.state || item.state === options.state)
      .sort(comparePriority);

    const view: QueueView = {
      snapshotAt: feed?.fetchedAt?.toISOString() ?? null,
      unavailable:
        feed?.unavailableReason && feed.unavailableAt
          ? {
              reason: feed.unavailableReason,
              at: feed.unavailableAt.toISOString(),
            }
          : null,
      readyLabel: readyLabelOf(project),
      round: round
        ? {
            date: formatDate(round.date),
            round: round.label,
            updatedAt: round.updatedAt.toISOString(),
          }
        : null,
      items,
      heldForLead: round ? heldForLead(decisionsOf(round.decisions)) : [],
    };
    if (options.includeOpen) {
      view.others = await this.others(projectId, states);
    }
    return view;
  }

  async issue(projectId: string, number: number): Promise<QueueIssueDetail> {
    const project = await this.project(projectId);
    const row = await this.prisma.queueStateRow.findUnique({
      where: { projectId_issueNumber: { projectId, issueNumber: number } },
    });
    if (!row) {
      throw queueError(
        404,
        QUEUE_ERROR.issueNotFound,
        `Issue #${number} is not in the queue`,
      );
    }
    const issues = await this.issues(projectId, [row]);
    const issue = issues.get(number);
    if (!issue) {
      throw queueError(
        404,
        QUEUE_ERROR.issueNotFound,
        `Issue #${number} is not in the queue`,
      );
    }
    const rounds = await this.prisma.round.findMany({
      where: { projectId },
      orderBy: [{ date: 'desc' }, { label: 'desc' }],
      take: QUEUE_HISTORY_ROUNDS,
    });
    const history: QueueHistoryEntry[] = rounds.flatMap((round) => {
      const verdict = boardVerdicts(decisionsOf(round.decisions)).get(number);
      return verdict
        ? [{ date: formatDate(round.date), round: round.label, ...verdict }]
        : [];
    });
    return {
      ...this.item(project.repo, row, issue, issues),
      body: issue.body,
      history,
    };
  }

  private async project(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { repo: true, readyLabelOverride: true, codeSentinelConfig: true },
    });
    if (!project) throw projectNotFound();
    return project;
  }

  /** The queued issues and the issues they depend on, by number. */
  private async issues(
    projectId: string,
    states: StateRow[],
  ): Promise<Map<number, IssueRow>> {
    const numbers = new Set(states.map((s) => s.issueNumber));
    for (const s of states) for (const n of numbersOf(s.blockers)) numbers.add(n);
    const rows = await this.prisma.issueCache.findMany({
      where: { projectId, number: { in: [...numbers] } },
    });
    return new Map(rows.map((r) => [r.number, r]));
  }

  private async others(
    projectId: string,
    states: StateRow[],
  ): Promise<OpenIssueView[]> {
    const rows = await this.prisma.issueCache.findMany({
      where: {
        projectId,
        kind: 'issue',
        state: 'open',
        number: { notIn: states.map((s) => s.issueNumber) },
      },
      orderBy: { number: 'asc' },
    });
    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      url: r.url,
      labels: labelsOf(r),
    }));
  }

  private item(
    repo: string,
    row: StateRow,
    issue: IssueRow,
    issues: Map<number, IssueRow>,
  ): QueueItemView {
    const computed: QueueVerdict = {
      state: row.state,
      why: row.why,
      clears: row.clears,
    };
    const orchestrator = orchestratorOf(row);
    const shown =
      row.source === 'orchestrator' && orchestrator ? orchestrator : computed;
    const labels = labelsOf(issue);
    const blockers: QueueBlocker[] = numbersOf(row.blockers).map((n) => {
      const dependency = issues.get(n);
      return {
        number: n,
        url: dependency?.url ?? `https://github.com/${repo}/issues/${n}`,
        open: dependency?.state === 'open',
      };
    });
    return {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels,
      assignees: assigneesOf(issue),
      ...shown,
      source: row.source,
      computed: row.source === 'orchestrator' ? computed : null,
      priority: priorityOf(labels),
      blockers,
      waveSlots: waveSlotsOf(row.waveSlots),
      ghUpdatedAt: issue.ghUpdatedAt.toISOString(),
    };
  }
}
