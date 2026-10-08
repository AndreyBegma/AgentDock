import type { BoardErrorView } from '@agentdock/shared';
import type { RoundDecisions } from '@agentdock/shared/protocol';
import { type OrchestratorStatus, Prisma } from '@prisma/client';
import type { Applied, Changes, EventOf, ProjectRef, Tx } from './projection';

export type RoundEvent = EventOf<'round.started' | 'round.decided'>;
export type OrchestratorEvent = EventOf<
  | 'orchestrator.started'
  | 'orchestrator.stopped'
  | 'board.unparsed'
  | 'pane.prompt'
  | 'pane.idle'
  | 'pane.quota_hit'
  | 'pane.busy'
>;

const EMPTY_DECISIONS: RoundDecisions = {
  dispatching: [],
  heldForLead: [],
  notDispatching: [],
  inFlight: [],
};

/** `YYYY-MM-DD` as the `DATE` column stores it. */
export const roundDate = (date: string): Date => new Date(`${date}T00:00:00Z`);

/**
 * Projects board events into `rounds`, and orchestrator presence and board
 * errors into `fleet_orchestrators` (spec 11 D4, D6). Same replay rule as
 * slots: an event at or below a row's `lastSeq` changes nothing.
 */
export class RoundProjection {
  constructor(
    private readonly tx: Tx,
    private readonly project: ProjectRef,
    private readonly changed: Changes,
  ) {}

  async round(applied: Applied<RoundEvent>): Promise<void> {
    const { event, ts, seq } = applied;
    const key = {
      projectId: this.project.id,
      date: roundDate(event.data.date),
      label: event.data.round,
    };
    const row = await this.tx.round.findUnique({
      where: { projectId_date_label: key },
      select: { id: true, lastSeq: true },
    });
    if (row && seq <= row.lastSeq) return;

    if (event.type === 'round.decided') {
      // The board's header always comes first; without it there is no round.
      if (!row) return;
      await this.tx.round.update({
        where: { id: row.id },
        data: {
          decisions: event.data.decisions as Prisma.InputJsonValue,
          lastSeq: seq,
          updatedAt: ts,
        },
      });
      this.changed({ kind: 'round', id: row.id });
      return;
    }

    const header = {
      base: event.data.base,
      occupied: event.data.occupied,
      max: event.data.max,
      free: event.data.free,
      boardPath: event.data.boardPath,
      source: event.source === 'scraped' ? 'scraped' : 'events',
      lastSeq: seq,
      updatedAt: ts,
    } as const;
    const saved = row
      ? await this.tx.round.update({
          where: { id: row.id },
          data: header,
          select: { id: true },
        })
      : await this.tx.round.create({
          data: {
            ...key,
            ...header,
            decisions: EMPTY_DECISIONS as unknown as Prisma.InputJsonValue,
            createdAt: ts,
          },
          select: { id: true },
        });
    this.changed({ kind: 'round', id: saved.id });
    await this.clearBoardError(applied);
  }

  async orchestrator(applied: Applied<OrchestratorEvent>): Promise<void> {
    const { event, seq } = applied;
    const row = await this.tx.fleetOrchestrator.findUnique({
      where: { projectId: this.project.id },
    });
    if (row && seq <= row.lastSeq) return;

    let status = row?.status ?? null;
    let session = row?.session ?? null;
    let boardError = row?.boardError ?? null;
    switch (event.type) {
      case 'orchestrator.started':
        status = 'running';
        session = event.data.session;
        break;
      case 'orchestrator.stopped':
        status = 'absent';
        session = event.data.session;
        break;
      case 'board.unparsed': {
        const error: BoardErrorView = {
          file: event.data.file,
          line: event.data.line ?? null,
          reason: event.data.reason,
          at: event.ts,
        };
        boardError = error as unknown as Prisma.JsonObject;
        break;
      }
      default:
        // A pane is only the orchestrator's while it runs (D6).
        if (status !== 'running' && status !== 'idle') return;
        status = event.type === 'pane.busy' ? 'running' : 'idle';
    }
    await this.save(row?.status ?? null, row?.since ?? null, applied, {
      status,
      session,
      boardError,
    });
  }

  /** A round that parsed supersedes the last board error (D4). */
  private async clearBoardError(applied: Applied<RoundEvent>): Promise<void> {
    const row = await this.tx.fleetOrchestrator.findUnique({
      where: { projectId: this.project.id },
    });
    if (!row || row.boardError === null || applied.seq <= row.lastSeq) return;
    await this.save(row.status, row.since, applied, {
      status: row.status,
      session: row.session,
      boardError: null,
    });
  }

  private async save(
    previous: OrchestratorStatus | null,
    since: Date | null,
    applied: Applied,
    next: {
      status: OrchestratorStatus | null;
      session: string | null;
      boardError: Prisma.JsonValue;
    },
  ): Promise<void> {
    const data = {
      status: next.status,
      session: next.session,
      since: next.status === previous ? since : applied.ts,
      boardError:
        next.boardError === null
          ? Prisma.DbNull
          : (next.boardError as Prisma.InputJsonValue),
      lastSeq: applied.seq,
      updatedAt: applied.ts,
    };
    await this.tx.fleetOrchestrator.upsert({
      where: { projectId: this.project.id },
      create: { projectId: this.project.id, ...data },
      update: data,
    });
    this.changed({ kind: 'orchestrator', id: this.project.id });
  }
}
