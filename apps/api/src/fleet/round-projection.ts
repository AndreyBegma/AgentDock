import type { BoardErrorView } from '@agentdock/shared';
import type { RoundDecisions } from '@agentdock/shared/protocol';
import { type OrchestratorStatus, Prisma } from '@prisma/client';
import { mayWrite, type RoundSources, readSources } from './field-sources';
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
 * slots: an event at or below a row's `lastSeq` changes nothing. A round's
 * header and decisions, once reported by Code Sentinel, are not overwritten
 * from the board (spec 16 D7) — except `base`, which the plugin never reports.
 */
export class RoundProjection {
  constructor(
    private readonly tx: Tx,
    private readonly project: ProjectRef,
    private readonly changed: Changes,
  ) {}

  async round(applied: Applied<RoundEvent>): Promise<void> {
    const { event, ts, seq } = applied;
    const select = { id: true, lastSeq: true, sources: true } as const;
    const { date, round } = event.data;
    const key =
      date && round
        ? { projectId: this.project.id, date: roundDate(date), label: round }
        : null;
    // `round.decided` from `events.jsonl` names no board: the latest round.
    const row = key
      ? await this.tx.round.findUnique({
          where: { projectId_date_label: key },
          select,
        })
      : await this.tx.round.findFirst({
          where: { projectId: this.project.id },
          orderBy: [{ date: 'desc' }, { label: 'desc' }],
          select,
        });
    if (row && seq <= row.lastSeq) return;
    const sources = readSources<RoundSources>(row?.sources ?? {});

    if (event.type === 'round.decided') {
      // The board's header always comes first; without it there is no round.
      if (!row) return;
      const write = mayWrite(sources.decisions, event.source);
      await this.tx.round.update({
        where: { id: row.id },
        data: {
          ...(write
            ? {
                decisions: event.data.decisions as Prisma.InputJsonValue,
                sources: { ...sources, decisions: event.source },
              }
            : {}),
          lastSeq: seq,
          updatedAt: ts,
        },
      });
      this.changed({ kind: 'round', id: row.id });
      return;
    }
    if (!key) return;

    // The header is the board's first line; a base the event lacks (the
    // plugin's) keeps the one the round has, else the project's.
    const header = {
      occupied: event.data.occupied,
      max: event.data.max,
      free: event.data.free,
      boardPath: event.data.boardPath,
      source: event.source === 'scraped' ? 'scraped' : 'events',
      sources: { ...sources, header: event.source },
    } as const;
    const saved = row
      ? await this.tx.round.update({
          where: { id: row.id },
          data: {
            ...(mayWrite(sources.header, event.source) ? header : {}),
            // The plugin never reports a base, so the board's always counts.
            ...(event.data.base ? { base: event.data.base } : {}),
            lastSeq: seq,
            updatedAt: ts,
          },
          select: { id: true },
        })
      : await this.tx.round.create({
          data: {
            ...key,
            ...header,
            base: event.data.base ?? this.project.base,
            decisions: EMPTY_DECISIONS as unknown as Prisma.InputJsonValue,
            lastSeq: seq,
            createdAt: ts,
            updatedAt: ts,
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
        session = event.data.session ?? session;
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
