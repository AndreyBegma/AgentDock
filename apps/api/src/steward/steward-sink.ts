import {
  isStewardEventType,
  STEWARD_ACTED_EVENT,
  STEWARD_OBSERVED_EVENT,
  type StewardActedData,
  type StewardObservedData,
  stewardActedDataSchema,
  stewardActionCount,
  stewardObservedDataSchema,
} from '@nautelle/shared';
import {
  HOOK_PROMPT_SUBMITTED_EVENT,
  HOOK_SESSION_STARTED_EVENT,
  HOOK_STOPPED_EVENT,
  HOOK_TOOL_FINISHED_EVENT,
  isCardPushEventType,
  type RunnerEvent,
} from '@nautelle/shared/protocol';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { StewardDecider } from './steward-decider';
import {
  actionsOf,
  LIVE_STATUSES,
  StewardIncidents,
  type StewardProject,
  stewardProjectSelect,
} from './steward-incidents.service';
import { sanitizeReason } from './steward-reason';
import { StewardSettingsService } from './steward-settings.service';

/**
 * Hook events that mean the session moved on — a prompt went in, a tool
 * finished, a resumed session started, a turn ended. A permission request
 * or a notification is the session waiting, never its recovery.
 */
const PROGRESS_HOOKS: ReadonlySet<string> = new Set([
  HOOK_PROMPT_SUBMITTED_EVENT,
  HOOK_TOOL_FINISHED_EVENT,
  HOOK_SESSION_STARTED_EVENT,
  HOOK_STOPPED_EVENT,
]);

/** Fleet events that show a slot working again, or gone (D5: observe-only). */
const FLEET_PROGRESS: ReadonlySet<string> = new Set([
  'pane.busy',
  'session.vanished',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * DA-12, D12: no pane text ever reaches `events.data` — the tail is removed
 * from every `steward.*` event in place, valid or not, before the batch is
 * stored (the `stripHookContent` pattern). The API keeps no copy: the kind,
 * the reason and the actions are what it stores.
 */
export const stripStewardContent = (event: RunnerEvent): void => {
  if (!isStewardEventType(event.type)) return;
  const data = asRecord(event.data);
  if (!data || !('paneTail' in data)) return;
  const { paneTail: _tail, ...kept } = data;
  event.data = kept;
};

/**
 * Sink `steward` (#447 D2, D13): the runner's `steward.observed` /
 * `steward.acted` into incidents, and the signals that close them — a card
 * session's progress, a push after a held one, a fleet slot busy again. It
 * never sends a command: decisions run after the batch.
 *
 * DA-04: a Steward event counts only with `source: runner` — never from the
 * Code Sentinel path a worker could write to — and only for the project the
 * envelope's root names on this runner; the round or run it names must be
 * that project's.
 */
@Injectable()
export class StewardSink implements RunnerEventSink, OnApplicationBootstrap {
  readonly name = 'steward';
  private readonly logger = new Logger(StewardSink.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly prisma: PrismaService,
    private readonly incidents: StewardIncidents,
    private readonly settings: StewardSettingsService,
    private readonly decider: StewardDecider,
  ) {}

  onApplicationBootstrap(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (isStewardEventType(event.type)) {
        // Parsed first: the tail is checked by the schema, then dropped.
        const data = event.data;
        stripStewardContent(event);
        await this.steward(runnerId, event, data);
        continue;
      }
      if (PROGRESS_HOOKS.has(event.type) && event.source === 'hook') {
        await this.progress(runnerId, event);
        continue;
      }
      if (isCardPushEventType(event.type) && event.source === 'runner') {
        await this.pushed(runnerId, event);
        continue;
      }
      if (FLEET_PROGRESS.has(event.type) && event.slot) {
        await this.slotMoved(runnerId, event, event.slot);
      }
    }
  }

  private async steward(
    runnerId: string,
    event: RunnerEvent,
    data: unknown,
  ): Promise<void> {
    if (event.source !== 'runner') {
      this.logger.warn(
        `runner ${runnerId}: ${event.type} with source ${event.source} (seq ${event.seq}), skipped`,
      );
      return;
    }
    const project = await this.projectOf(runnerId, event);
    if (!project) {
      this.logger.warn(
        `runner ${runnerId}: ${event.type} (seq ${event.seq}) for an unknown project, skipped`,
      );
      return;
    }
    if (!(await this.settings.of(project.id)).enabled) return;
    if (event.type === STEWARD_OBSERVED_EVENT) {
      const parsed = stewardObservedDataSchema.safeParse(data);
      if (!parsed.success || parsed.data.projectId !== project.id) {
        this.skip(runnerId, event);
        return;
      }
      await this.observed(project, parsed.data);
      return;
    }
    if (event.type === STEWARD_ACTED_EVENT) {
      const parsed = stewardActedDataSchema.safeParse(data);
      if (!parsed.success || parsed.data.projectId !== project.id) {
        this.skip(runnerId, event);
        return;
      }
      await this.acted(project, parsed.data);
    }
  }

  private async observed(
    project: StewardProject,
    data: StewardObservedData,
  ): Promise<void> {
    const reason = sanitizeReason(data.reason);
    const subject = await this.incidents.subjectOf(project, data.subject);
    if (!reason || !subject) return;
    const at = this.clamp(data.at);
    const incident = await this.incidents.observe(
      project,
      subject,
      data.kind,
      reason,
      at,
    );
    if (data.classifierSessionId) {
      await this.classifierRun(project.id, data.classifierSessionId, at);
    }
    this.decider.later(incident.id, data.dialogId);
  }

  private async acted(
    project: StewardProject,
    data: StewardActedData,
  ): Promise<void> {
    const subject = await this.incidents.subjectOf(project, data.subject);
    if (!subject) return;
    if (data.action !== 'hold_push') {
      // A commanded action is claimed when sent; this settles one left
      // without an answer.
      await this.decider.confirm(project, subject, data.action, data.result);
      return;
    }
    // D7: the runner held a push by itself — recorded on the trailer
    // incident, opened here when its observation has not come.
    const detail = data.detail ? sanitizeReason(data.detail) : null;
    const at = this.clamp(data.at);
    const live = await this.incidents.live(subject.kind, subject.id);
    const incident =
      live?.kind === 'trailer'
        ? live
        : await this.incidents.observe(
            project,
            subject,
            'trailer',
            'a card commit carries a Claude attribution trailer',
            at,
          );
    await this.incidents.append(
      project,
      subject,
      incident.id,
      {
        action: 'hold_push',
        at: at.toISOString(),
        result: data.result,
        ...(detail ? { detail } : {}),
      },
      stewardActionCount(actionsOf(incident.actions), 'hold_push') + 1,
    );
  }

  /** A card session moved on after its incident opened: recovered (D13). */
  private async progress(runnerId: string, event: RunnerEvent): Promise<void> {
    const sessionId = event.session?.id;
    if (!sessionId || !UUID.test(sessionId)) return;
    const card = await this.prisma.boardCard.findFirst({
      where: { sessionId, project: { runnerId } },
      select: {
        project: { select: stewardProjectSelect },
        rounds: { orderBy: { round: 'desc' }, take: 1, select: { id: true } },
      },
    });
    const round = card?.rounds[0];
    if (!card || !round) return;
    const at = new Date(event.ts);
    await this.resolveLive(
      card.project,
      'card_round',
      round.id,
      (incident) => incident.kind !== 'trailer' && incident.openedAt < at,
    );
  }

  /** D7: a push of the round after the hold went through — the rewrite landed. */
  private async pushed(runnerId: string, event: RunnerEvent): Promise<void> {
    const data = asRecord(event.data);
    const runId = typeof data?.runId === 'string' ? data.runId : null;
    if (!runId) return;
    const round = await this.prisma.boardCardRound.findFirst({
      where: { runId, card: { project: { runnerId } } },
      select: {
        id: true,
        card: { select: { project: { select: stewardProjectSelect } } },
      },
    });
    if (!round) return;
    const at = new Date(event.ts);
    await this.resolveLive(
      round.card.project,
      'card_round',
      round.id,
      (i) => i.kind === 'trailer' && i.openedAt < at,
    );
  }

  /** D5: a fleet slot busy again, or gone, ends its incident. */
  private async slotMoved(
    runnerId: string,
    event: RunnerEvent,
    slot: string,
  ): Promise<void> {
    const project = await this.projectOf(runnerId, event);
    if (!project) return;
    const at = new Date(event.ts);
    await this.resolveLive(project, 'fleet_slot', slot, (i) => i.openedAt < at);
  }

  private async resolveLive(
    project: StewardProject,
    subjectKind: 'card_round' | 'fleet_slot',
    subjectId: string,
    matches: (incident: { kind: string; openedAt: Date }) => boolean,
  ): Promise<void> {
    const live = await this.prisma.stewardIncident.findMany({
      where: {
        projectId: project.id,
        subjectKind,
        subjectId,
        status: { in: LIVE_STATUSES },
      },
    });
    const due = live.filter(matches);
    if (due.length === 0) return;
    const subject = await this.incidents.subjectFor(due[0]);
    for (const incident of due) {
      await this.incidents.resolve(project, subject, incident.id);
    }
  }

  /**
   * D16: haiku's classification is a `steward` run of the project — once
   * per Claude session — so it shows in History; its spend is the session's
   * usage, which the project budget already counts.
   */
  private async classifierRun(
    projectId: string,
    sessionId: string,
    at: Date,
  ): Promise<void> {
    const existing = await this.prisma.run.findFirst({
      where: {
        projectId,
        kind: 'steward',
        args: { path: ['classifierSessionId'], equals: sessionId },
      },
      select: { id: true },
    });
    if (existing) return;
    await this.prisma.run.create({
      data: {
        kind: 'steward',
        projectId,
        title: 'Steward: classify a stall',
        runtime: 'claude',
        args: { classifierSessionId: sessionId },
        status: 'succeeded',
        triggeredByType: 'orchestrator',
        startedAt: at,
        endedAt: at,
        durationMs: 0,
        updatedAt: at,
      },
    });
  }

  /** The envelope's project on this runner — never the event data's (DA-04). */
  private projectOf(
    runnerId: string,
    event: RunnerEvent,
  ): Promise<StewardProject | null> {
    const root = event.project?.root;
    if (!root) return Promise.resolve(null);
    return this.prisma.project.findFirst({
      where: { runnerId, rootPath: root },
      select: stewardProjectSelect,
    });
  }

  /** The runner's clock, never ahead of the API's. */
  private clamp(at: string): Date {
    const t = Date.parse(at);
    return new Date(Math.min(Number.isFinite(t) ? t : Date.now(), Date.now()));
  }

  private skip(runnerId: string, event: RunnerEvent): void {
    this.logger.warn(
      `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
    );
  }
}
