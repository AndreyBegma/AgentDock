import {
  BOARD_CARD_BODY_MAX,
  BOARD_CARD_TITLE_MAX,
  type BoardCardKind,
  type BoardColumn,
  type CardChange,
  type CardFleetView,
  FLEET_STAGES,
  type FleetCardEdit,
  type FleetCardEdits,
  type FleetStage,
  stageOf,
} from '@agentdock/shared';
import {
  isFleetEventType,
  parseQueueEvent,
  type RunnerEvent,
  SLOT_MESSAGE_MAX_BYTES,
} from '@agentdock/shared/protocol';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import type { BoardCard, Prisma, Slot } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { type AuditContext, userActor } from '../audit/audit.types';
import { BOARD_SYSTEM_ACTOR, BoardWork } from '../board';
import { FleetCardEditsRef } from '../board/board.service';
import { ControlService } from '../control/control.service';
import { PrismaService } from '../database/prisma.service';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';

type Tx = Prisma.TransactionClient;

/** #282 D4: a `fleet` card's slot fields, for `BoardCardView.fleet`. */
export const cardFleetView = (
  card: Pick<
    BoardCard,
    'source' | 'fleetIssue' | 'fleetSlot' | 'fleetStage' | 'fleetSlotGone'
  >,
): CardFleetView | null =>
  card.source === 'fleet' && card.fleetIssue !== null
    ? {
        issue: card.fleetIssue,
        slot: card.fleetSlot,
        stage: isFleetStage(card.fleetStage) ? card.fleetStage : null,
        slotGone: card.fleetSlotGone,
      }
    : null;

const isFleetStage = (value: string | null): value is FleetStage =>
  value !== null && (FLEET_STAGES as readonly string[]).includes(value);

/** A slot whose session is up: an edit reaches it now. */
const LIVE_STATUSES: ReadonlySet<Slot['status']> = new Set([
  'running',
  'idle',
  'prompt',
  'quota',
]);

/** Where a slot's card belongs; `null` keeps the card where it is. */
const columnOf = (slot: Slot): BoardColumn | null => {
  if (slot.prNumber !== null && slot.prState !== 'closed') return 'finished';
  return slot.status === 'ended' ? null : 'in_progress';
};

/** The slot left the projection: its run ended without a merge. */
const slotGoneOf = (slot: Slot): boolean =>
  slot.status === 'ended' && slot.prState !== 'merged';

/** Cuts `text` to at most `max` UTF-8 bytes on a code point, with `suffix`. */
const cutToBytes = (text: string, max: number, suffix: string): string => {
  if (Buffer.byteLength(text) <= max) return text;
  const budget = max - Buffer.byteLength(suffix);
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return out + suffix;
};

const BODY_CUT_SUFFIX = '… (cut to fit)';

const kindName = (kind: BoardCardKind): string =>
  kind === 'bug' ? 'bug fix' : 'feature';

const editMessage = (label: string, change: CardChange, body: string) => {
  const { fields, before, now } = change;
  const lines = [
    `## Card ${label} was edited`,
    '',
    `The person edited Board card ${label}, which mirrors this slot. The GitHub issue is unchanged; the card as it is now:`,
    '',
    fields.includes('title')
      ? `Title: ${now.title} (was: ${before.title})`
      : `Title: ${now.title}`,
  ];
  if (fields.includes('kind')) {
    lines.push(`Kind: ${kindName(now.kind)} (was: ${kindName(before.kind)})`);
  }
  if (fields.includes('body')) {
    lines.push('', '### Description', '', body || '(no description)');
  }
  lines.push(
    '',
    'Adjust your work to the card as it is now, and report what you changed in .orchestrator-reply.md.',
  );
  return lines.join('\n');
};

/**
 * #282 D4: the `slot.message` text of an edit. A cs-worker slot reports in
 * its reply file, so this is not the card worker's next-round prompt. The
 * body is cut on a code point so the text fits `SLOT_MESSAGE_MAX_BYTES`.
 */
export const fleetEditMessage = (edit: FleetCardEdit): string => {
  const body = edit.change.now.body.trim();
  const message = editMessage(edit.label, edit.change, body);
  const over = Buffer.byteLength(message) - SLOT_MESSAGE_MAX_BYTES;
  if (over <= 0) return message;
  return editMessage(
    edit.label,
    edit.change,
    cutToBytes(
      body,
      Math.max(0, Buffer.byteLength(body) - over),
      BODY_CUT_SUFFIX,
    ),
  );
};

/**
 * The Board's fleet mirror (#282 D4, ADR-0030 §4): one `fleet` card per
 * dispatched slot, keyed `(projectId, issue, slot)`, and one To Do card per
 * ready issue no slot has picked up, keyed `(projectId, issue, null)`. The
 * card's column follows its slot; only a person moves it Finished →
 * Completed. Its text is a person's to edit: an edit reaches the running slot
 * as one `slot.message`, and the GitHub issue is never rewritten.
 *
 * A runner-event sink registered at bootstrap, so it runs after the fleet
 * and queue sinks (registered in `onModuleInit`): the batch's slots and ready
 * issues are projected before the mirror reads them.
 */
@Injectable()
export class BoardFleetService
  implements
    FleetCardEdits,
    RunnerEventSink,
    OnModuleInit,
    OnApplicationBootstrap
{
  readonly name = 'board-fleet';
  private readonly logger = new Logger(BoardFleetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sinks: RunnerEventSinks,
    private readonly work: BoardWork,
    private readonly control: ControlService,
    private readonly audit: AuditService,
    private readonly edits: FleetCardEditsRef,
  ) {}

  /** `BoardService.update` tells the fleet of a fleet card's edit through this. */
  onModuleInit(): void {
    this.edits.set(this);
  }

  onApplicationBootstrap(): void {
    this.sinks.register(this);
  }

  /** Mirrors every project the batch's fleet or queue events touched. */
  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    const roots = new Set<string>();
    for (const event of events) {
      if (!event.project) continue;
      if (isFleetEventType(event.type) || parseQueueEvent(event)?.ok) {
        roots.add(event.project.root);
      }
    }
    if (roots.size === 0) return;
    const projects = await this.prisma.project.findMany({
      where: { runnerId, rootPath: { in: [...roots] } },
      select: { id: true },
    });
    for (const { id } of projects) await this.mirror(id);
  }

  /** Brings the project's `fleet` cards in line with its slots and ready issues. */
  async mirror(projectId: string): Promise<void> {
    const { created, moves, touched } = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`board-fleet:${projectId}`}))`;
        return this.reconcile(tx, projectId);
      },
    );
    for (const card of created) {
      await this.audit.record({
        ...BOARD_SYSTEM_ACTOR.ctx,
        action: 'card.created',
        target: { type: 'board_card', id: card.id },
        projectId,
        after: {
          number: card.number,
          title: card.title,
          source: 'fleet',
          issue: card.fleetIssue,
          slot: card.fleetSlot,
        },
        result: 'ok',
      });
    }
    for (const id of touched) this.work.publish(projectId, id);
    if (moves.length === 0) return;
    const project = await this.work.project(projectId);
    for (const { number, to } of moves) {
      const card = await this.work.card(projectId, number);
      if (card.column === to || card.column === 'completed') continue;
      await this.work.move(
        project,
        card,
        { to, index: 0, source: 'automatic' },
        BOARD_SYSTEM_ACTOR,
      );
    }
  }

  private async reconcile(
    tx: Tx,
    projectId: string,
  ): Promise<{
    created: BoardCard[];
    moves: { number: number; to: BoardColumn }[];
    touched: string[];
  }> {
    const runs = await tx.slot.findMany({
      where: { projectId, issue: { not: null } },
      orderBy: { startedAt: 'desc' },
      include: { checkpoints: { select: { kind: true } } },
    });
    // The latest run of each (issue, slot): a name is reused by later runs.
    const latest = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
      const key = `${run.issue}:${run.name}`;
      if (!latest.has(key)) latest.set(key, run);
    }
    const cards = await tx.boardCard.findMany({
      where: { projectId, source: 'fleet' },
    });
    const byKey = new Map(
      cards.map((c) => [`${c.fleetIssue}:${c.fleetSlot ?? ''}`, c]),
    );

    const created: BoardCard[] = [];
    const moves: { number: number; to: BoardColumn }[] = [];
    const touched: string[] = [];

    // Slots, lead first, so a ready issue's To Do card goes to its lead.
    const slots = [...latest.values()].sort(
      (a, b) =>
        Number(b.lead === true) - Number(a.lead === true) ||
        a.startedAt.getTime() - b.startedAt.getTime(),
    );
    for (const slot of slots) {
      const issue = slot.issue as number;
      const stage = stageOf({
        status: slot.status,
        lastCheckpoint: slot.lastCheckpoint,
        checkpoints: slot.checkpoints.map((c) => c.kind),
        prNumber: slot.prNumber,
        prState: slot.prState,
        prChecks: slot.prChecks,
      });
      const fields = {
        fleetStage: stage,
        fleetSlotGone: slotGoneOf(slot),
        prNumber: slot.prNumber,
        prUrl: slot.prUrl,
        // #329 D6: the PR's state from the fleet's PR poll.
        prState: slot.prNumber === null ? null : slot.prState,
      };
      const to = columnOf(slot);
      let card = byKey.get(`${issue}:${slot.name}`);
      if (!card) {
        const unslotted = byKey.get(`${issue}:`);
        if (unslotted) {
          // #282 D4: the issue's first slot takes over its To Do card.
          byKey.delete(`${issue}:`);
          card = await tx.boardCard.update({
            where: { id: unslotted.id },
            data: { fleetSlot: slot.name, ...fields },
          });
          byKey.set(`${issue}:${slot.name}`, card);
          touched.push(card.id);
          if (to) moves.push({ number: card.number, to });
          continue;
        }
        // An ended run never gets a card: the slot history is not work.
        if (slot.status === 'ended') continue;
        card = await this.create(tx, projectId, issue, slot.name, fields);
        byKey.set(`${issue}:${slot.name}`, card);
        created.push(card);
        touched.push(card.id);
        if (to && to !== card.column) {
          moves.push({ number: card.number, to });
        }
        continue;
      }
      if (
        card.fleetStage !== fields.fleetStage ||
        card.fleetSlotGone !== fields.fleetSlotGone ||
        card.prNumber !== fields.prNumber ||
        card.prUrl !== fields.prUrl ||
        card.prState !== fields.prState
      ) {
        await tx.boardCard.update({ where: { id: card.id }, data: fields });
        touched.push(card.id);
      }
      if (to && to !== card.column && card.column !== 'completed') {
        moves.push({ number: card.number, to });
      }
    }

    // Ready issues no slot has run for and no card mirrors yet: one To Do card.
    const issuesWithRuns = new Set(runs.map((r) => r.issue));
    const mirrored = new Set([...byKey.values()].map((c) => c.fleetIssue));
    const ready = await tx.queueStateRow.findMany({
      where: { projectId },
      select: { issueNumber: true },
      orderBy: { issueNumber: 'asc' },
    });
    for (const { issueNumber } of ready) {
      if (issuesWithRuns.has(issueNumber) || mirrored.has(issueNumber)) {
        continue;
      }
      const card = await this.create(tx, projectId, issueNumber, null, {
        fleetStage: null,
        fleetSlotGone: false,
        prNumber: null,
        prUrl: null,
        prState: null,
      });
      created.push(card);
      touched.push(card.id);
    }
    return { created, moves, touched };
  }

  /**
   * A new `fleet` card in To Do, titled and described from the issue as the
   * queue last saw it; later issue edits never overwrite a person's edit.
   * It gets no `branch`: Accept closes a card's worktree by its branch, and
   * the slot's worktree is the orchestrator's.
   */
  private async create(
    tx: Tx,
    projectId: string,
    issue: number,
    slot: string | null,
    fields: Pick<
      BoardCard,
      'fleetStage' | 'fleetSlotGone' | 'prNumber' | 'prUrl' | 'prState'
    >,
  ): Promise<BoardCard> {
    const cached = await tx.issueCache.findUnique({
      where: { projectId_number: { projectId, number: issue } },
      select: { title: true, body: true, url: true },
    });
    const project = await tx.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { repo: true },
    });
    const { number, shortId } = await this.work.nextCard(tx, projectId);
    const position = await this.work.place(
      tx,
      { id: '', projectId },
      'todo',
      0,
    );
    const title = (cached?.title.trim() || `Issue #${issue}`).slice(
      0,
      BOARD_CARD_TITLE_MAX,
    );
    return tx.boardCard.create({
      data: {
        projectId,
        number,
        shortId,
        title,
        body: (cached?.body ?? '').slice(0, BOARD_CARD_BODY_MAX),
        column: 'todo',
        position,
        source: 'fleet',
        issueOnRun: false,
        specOnRun: false,
        issueNumber: issue,
        issueUrl:
          cached?.url ?? `https://github.com/${project.repo}/issues/${issue}`,
        fleetIssue: issue,
        fleetSlot: slot,
        movedAt: new Date(),
        ...fields,
      },
    });
  }

  /**
   * #282 D4: a person edited a `fleet` card's text. A slot whose session is
   * live gets one `slot.message` worded as the next round; a slot that is
   * not running, an unslotted card or an offline runner gets nothing, and
   * nothing here throws — the edit is stored either way.
   */
  async cardEdited(edit: FleetCardEdit): Promise<void> {
    const { editor } = edit;
    // Attachments live in card worktrees; a slot's worktree has none.
    if (edit.change.fields.length === 0) return;
    try {
      const card = await this.prisma.boardCard.findUnique({
        where: { id: edit.cardId },
        select: { source: true, fleetIssue: true, fleetSlot: true },
      });
      if (card?.source !== 'fleet' || card.fleetSlot === null) return;
      const slot = await this.prisma.slot.findFirst({
        where: {
          projectId: edit.projectId,
          name: card.fleetSlot,
          issue: card.fleetIssue,
        },
        orderBy: { startedAt: 'desc' },
        select: { status: true },
      });
      if (!slot || !LIVE_STATUSES.has(slot.status)) return;
      const ctx: AuditContext = { actor: userActor(editor.userId) };
      await this.control.messageSlot(
        {
          projectId: edit.projectId,
          role: 'operator',
          user: { id: editor.userId, email: editor.email },
          ctx,
        },
        card.fleetSlot,
        fleetEditMessage(edit),
      );
    } catch (error) {
      this.logger.warn(
        `edit of ${edit.label} not sent to its slot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
