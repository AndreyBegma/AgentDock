import { createHash } from 'node:crypto';
import {
  cardLabel,
  STEWARD_INCIDENT_EVENTS,
  STEWARD_INCIDENTS_PAGE_MAX,
  type StewardActionRecord,
  type StewardIncidentEventData,
  type StewardIncidentEventType,
  type StewardIncidentKind,
  type StewardIncidentStatus,
  type StewardIncidentView,
  type StewardSubject,
  type StewardSubjectKind,
  stewardActionRecordsSchema,
} from '@agentdock/shared';
import { API_EVENT_SOURCE } from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import { Prisma, type StewardIncident } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { recordServerEvent } from '../server-events';

type Tx = Prisma.TransactionClient;

/** What Steward needs of a project: its anchor in `events`. */
export interface StewardProject {
  id: string;
  runnerId: string;
  rootPath: string;
  repo: string;
}

export const stewardProjectSelect = {
  id: true,
  runnerId: true,
  rootPath: true,
  repo: true,
} as const;

/**
 * A subject as the API knows it: `id` is the `board_card_rounds.id`, the
 * `runs.id` or the slot name (spec "Data / Schema").
 */
export interface ResolvedSubject {
  kind: StewardSubjectKind;
  id: string;
  label: string | null;
  /** `card_round`: the card's number, for the Board link. */
  cardNumber?: number;
}

/** An incident that is still a person's concern or Steward's. */
export const LIVE_STATUSES: StewardIncidentStatus[] = ['open', 'escalated'];

/** The incident's `actions`, oldest first; a row that does not parse has none. */
export const actionsOf = (json: Prisma.JsonValue): StewardActionRecord[] => {
  const parsed = stewardActionRecordsSchema.safeParse(json);
  return parsed.success ? parsed.data : [];
};

const short = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * The incident lifecycle (#447 D13): open → (acted) → escalated → resolved.
 * One live incident per subject; every step is a `steward_incident.*` event
 * the API records itself (`source: api`), which Activity shows and the
 * notification matcher reads. Each step is keyed, so a retry or a second API
 * instance records it once.
 */
@Injectable()
export class StewardIncidents {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * DA-04: the subject named by an observation, only when it belongs to
   * `project` — a card round by its run and card, a run by its id. A fleet
   * slot is its name. `null`: not this project's, or no longer there.
   */
  async subjectOf(
    project: StewardProject,
    subject: StewardSubject,
  ): Promise<ResolvedSubject | null> {
    switch (subject.kind) {
      case 'card_round': {
        const round = await this.prisma.boardCardRound.findFirst({
          where: {
            runId: subject.runId,
            cardId: subject.cardId,
            card: { projectId: project.id },
          },
          select: { id: true, card: { select: { number: true } } },
        });
        return round
          ? {
              kind: 'card_round',
              id: round.id,
              label: cardLabel(round.card.number),
              cardNumber: round.card.number,
            }
          : null;
      }
      case 'run': {
        const run = await this.prisma.run.findFirst({
          where: { id: subject.runId, projectId: project.id },
          select: {
            id: true,
            title: true,
            cardRound: { select: { id: true } },
          },
        });
        // A card's run is observed as its round.
        if (!run || run.cardRound) return null;
        return { kind: 'run', id: run.id, label: run.title ?? null };
      }
      case 'fleet_slot':
        return { kind: 'fleet_slot', id: subject.slot, label: subject.slot };
    }
  }

  /** A stored incident's subject, with its label and card number. */
  async subjectFor(
    incident: Pick<StewardIncident, 'subjectKind' | 'subjectId'>,
  ): Promise<ResolvedSubject> {
    const base = { kind: incident.subjectKind, id: incident.subjectId };
    switch (incident.subjectKind) {
      case 'card_round': {
        const round = await this.prisma.boardCardRound.findUnique({
          where: { id: incident.subjectId },
          select: { card: { select: { number: true } } },
        });
        return round
          ? {
              ...base,
              label: cardLabel(round.card.number),
              cardNumber: round.card.number,
            }
          : { ...base, label: null };
      }
      case 'run': {
        const run = await this.prisma.run.findUnique({
          where: { id: incident.subjectId },
          select: { title: true },
        });
        return { ...base, label: run?.title ?? null };
      }
      case 'fleet_slot':
        return { ...base, label: incident.subjectId };
    }
  }

  /** The subject's live incident, newest first. */
  live(
    subjectKind: StewardSubjectKind,
    subjectId: string,
    db: Tx | PrismaService = this.prisma,
  ) {
    return db.stewardIncident.findFirst({
      where: { subjectKind, subjectId, status: { in: LIVE_STATUSES } },
      orderBy: { openedAt: 'desc' },
    });
  }

  /**
   * An observation of `kind` for the subject (D13): the live incident of
   * that kind takes the new reason; one of another kind is resolved — the
   * stall changed — and a new one opens. Returns the incident.
   */
  async observe(
    project: StewardProject,
    subject: ResolvedSubject,
    kind: StewardIncidentKind,
    reason: string,
    at: Date,
  ): Promise<StewardIncident> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSubject(tx, subject);
      const live = await this.live(subject.kind, subject.id, tx);
      if (live && live.kind === kind) {
        if (live.reason === reason) return live;
        return tx.stewardIncident.update({
          where: { id: live.id },
          data: { reason },
        });
      }
      if (live) await this.resolveIn(tx, project, subject, live, at);
      const created = await tx.stewardIncident.create({
        data: {
          projectId: project.id,
          subjectKind: subject.kind,
          subjectId: subject.id,
          kind,
          reason,
          openedAt: at,
        },
      });
      await this.event(
        tx,
        project,
        subject,
        created,
        STEWARD_INCIDENT_EVENTS.opened,
        created.id,
      );
      return created;
    });
  }

  /**
   * D13: a person hears of the incident once per reason — the first
   * escalation, and again only when the reason changed since. Returns
   * whether this call escalated it.
   */
  async escalate(
    project: StewardProject,
    subject: ResolvedSubject,
    incidentId: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSubject(tx, subject);
      const incident = await tx.stewardIncident.findUnique({
        where: { id: incidentId },
      });
      if (!incident || !LIVE_STATUSES.includes(incident.status)) return false;
      if (incident.notifiedReason === incident.reason) return false;
      await tx.stewardIncident.update({
        where: { id: incident.id },
        data: { status: 'escalated', notifiedReason: incident.reason },
      });
      await this.event(
        tx,
        project,
        subject,
        incident,
        STEWARD_INCIDENT_EVENTS.escalated,
        `${incident.id}:${short(incident.reason)}`,
      );
      return true;
    });
  }

  /** D13: recovery — a `resolved` Activity entry, never a notification. */
  async resolve(
    project: StewardProject,
    subject: ResolvedSubject,
    incidentId: string,
    at = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSubject(tx, subject);
      const incident = await tx.stewardIncident.findUnique({
        where: { id: incidentId },
      });
      if (!incident) return false;
      return this.resolveIn(tx, project, subject, incident, at);
    });
  }

  /**
   * Appends an action to a live incident — the claim of an attempt before
   * its command is sent. Conditional on the actions read: a concurrent claim
   * makes this one lose, so an attempt is sent once. Returns the attempt's
   * number among the round's actions of its kind, or null when lost.
   */
  async claim(
    subject: ResolvedSubject,
    incident: StewardIncident,
    record: StewardActionRecord,
  ): Promise<StewardIncident | null> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSubject(tx, subject);
      const fresh = await tx.stewardIncident.findUnique({
        where: { id: incident.id },
      });
      if (!fresh || fresh.status !== 'open') return null;
      if (JSON.stringify(fresh.actions) !== JSON.stringify(incident.actions)) {
        return null;
      }
      return tx.stewardIncident.update({
        where: { id: incident.id },
        data: {
          actions: [
            ...actionsOf(fresh.actions),
            record,
          ] as Prisma.InputJsonArray,
        },
      });
    });
  }

  /**
   * Sets the outcome of the incident's attempt at `index` and records the
   * `acted` Activity entry once per attempt.
   */
  async settle(
    project: StewardProject,
    subject: ResolvedSubject,
    incidentId: string,
    index: number,
    outcome: Pick<StewardActionRecord, 'result' | 'detail'>,
    attempt: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockSubject(tx, subject);
      const incident = await tx.stewardIncident.findUnique({
        where: { id: incidentId },
      });
      if (!incident) return;
      const actions = actionsOf(incident.actions);
      const current = actions[index];
      if (!current) return;
      const { detail: _pending, ...rest } = current;
      actions[index] = {
        ...rest,
        result: outcome.result,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      };
      await tx.stewardIncident.update({
        where: { id: incident.id },
        data: { actions: actions as Prisma.InputJsonArray },
      });
      await this.event(
        tx,
        project,
        subject,
        incident,
        STEWARD_INCIDENT_EVENTS.acted,
        `${incident.id}:${index}`,
        { action: current.action, result: outcome.result, attempt },
      );
    });
  }

  /** The runner's own action (D7 `hold_push`): appended and recorded at once. */
  async append(
    project: StewardProject,
    subject: ResolvedSubject,
    incidentId: string,
    record: StewardActionRecord,
    attempt: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockSubject(tx, subject);
      const incident = await tx.stewardIncident.findUnique({
        where: { id: incidentId },
      });
      if (!incident) return;
      const actions = actionsOf(incident.actions);
      await tx.stewardIncident.update({
        where: { id: incident.id },
        data: { actions: [...actions, record] as Prisma.InputJsonArray },
      });
      await this.event(
        tx,
        project,
        subject,
        incident,
        STEWARD_INCIDENT_EVENTS.acted,
        `${incident.id}:${actions.length}`,
        { action: record.action, result: record.result, attempt },
      );
    });
  }

  /**
   * `GET …/steward/incidents`: newest first, at most a page. `subjectIds`
   * narrows to the given subjects (a card's rounds).
   */
  async list(
    projectId: string,
    filter: {
      status?: StewardIncidentStatus;
      from?: string;
      to?: string;
      subjectIds?: string[];
    },
  ): Promise<StewardIncidentView[]> {
    const rows = await this.prisma.stewardIncident.findMany({
      where: {
        projectId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from || filter.to
          ? {
              openedAt: {
                ...(filter.from ? { gte: new Date(filter.from) } : {}),
                ...(filter.to ? { lt: new Date(filter.to) } : {}),
              },
            }
          : {}),
        ...(filter.subjectIds
          ? { subjectKind: 'card_round', subjectId: { in: filter.subjectIds } }
          : {}),
      },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      take: STEWARD_INCIDENTS_PAGE_MAX,
    });
    const labels = await this.labels(projectId, rows);
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      subjectLabel: labels.get(`${row.subjectKind}:${row.subjectId}`) ?? null,
      kind: row.kind,
      reason: row.reason,
      actions: actionsOf(row.actions),
      status: row.status,
      openedAt: row.openedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    }));
  }

  /** What a person reads for each subject: `C-12`, a run's title, a slot. */
  private async labels(
    projectId: string,
    rows: readonly StewardIncident[],
  ): Promise<Map<string, string>> {
    const ids = (kind: StewardSubjectKind) => [
      ...new Set(
        rows.filter((r) => r.subjectKind === kind).map((r) => r.subjectId),
      ),
    ];
    const [rounds, runs] = await Promise.all([
      this.prisma.boardCardRound.findMany({
        where: { id: { in: ids('card_round') }, card: { projectId } },
        select: { id: true, card: { select: { number: true } } },
      }),
      this.prisma.run.findMany({
        where: { id: { in: ids('run') }, projectId },
        select: { id: true, title: true },
      }),
    ]);
    const labels = new Map<string, string>();
    for (const r of rounds) {
      labels.set(`card_round:${r.id}`, cardLabel(r.card.number));
    }
    for (const r of runs) if (r.title) labels.set(`run:${r.id}`, r.title);
    for (const slot of ids('fleet_slot')) {
      labels.set(`fleet_slot:${slot}`, slot);
    }
    return labels;
  }

  private async resolveIn(
    tx: Tx,
    project: StewardProject,
    subject: ResolvedSubject,
    incident: StewardIncident,
    at: Date,
  ): Promise<boolean> {
    const { count } = await tx.stewardIncident.updateMany({
      where: { id: incident.id, status: { in: LIVE_STATUSES } },
      data: { status: 'resolved', resolvedAt: at },
    });
    if (count === 0) return false;
    await this.event(
      tx,
      project,
      subject,
      incident,
      STEWARD_INCIDENT_EVENTS.resolved,
      incident.id,
    );
    return true;
  }

  /** Serializes every change to one subject's incidents. */
  private async lockSubject(tx: Tx, subject: ResolvedSubject): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`steward:${subject.kind}:${subject.id}`}))`;
  }

  private async event(
    tx: Tx,
    project: StewardProject,
    subject: ResolvedSubject,
    incident: StewardIncident,
    type: StewardIncidentEventType,
    key: string,
    extra: Pick<StewardIncidentEventData, 'action' | 'result' | 'attempt'> = {},
  ): Promise<void> {
    const data: StewardIncidentEventData = {
      incidentId: incident.id,
      subjectKind: subject.kind,
      subjectId: subject.id,
      ...(subject.label ? { subjectLabel: subject.label.slice(0, 200) } : {}),
      ...(subject.cardNumber ? { cardNumber: subject.cardNumber } : {}),
      kind: incident.kind,
      reason: incident.reason,
      ...extra,
    };
    await recordServerEvent(tx, {
      source: API_EVENT_SOURCE,
      type,
      ts: new Date(),
      project: {
        runnerId: project.runnerId,
        rootPath: project.rootPath,
        repo: project.repo,
      },
      data: { ...data },
      dedupeKey: `${type}:${key}`,
    });
  }
}
