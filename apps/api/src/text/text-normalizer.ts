import { randomUUID } from 'node:crypto';
import {
  type BoardCardKind,
  buildNormalizePrompt,
  classifyCardKindEnglish,
  type DeepLError,
  isDeepLFinal,
  needsNormalizeCall,
  parseNormalizeOutput,
  prepareTextFields,
  type ResolvedTextField,
  RUN_UPDATED_LIVE_EVENT,
  type RunLiveChange,
  resolveDeepLFields,
  resolveNormalizedFields,
  TEXT_CHANGED_EVENT,
  TEXT_DEEPL_TIMEOUT_MS,
  TEXT_ERROR_MAX,
  TEXT_MAX_RUNNING_PER_PROJECT,
  TEXT_NORMALIZE_MODEL,
  TEXT_NORMALIZE_TIMEOUT_SEC,
  TEXT_OFFLINE_GIVE_UP_MS,
  TEXT_RUN_RETRIES,
  type TextChangedData,
  type TextFailReason,
  type TextField,
  type TextFieldInput,
  textFieldsSchema,
  textOfflineBackoffMs,
  textSourceHash,
  textViolationError,
  toDeepLXml,
} from '@agentdock/shared';
import type {
  TextNormalizeArgs,
  TextNormalizeFinishedData,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma, RunStatus, TextNormalization } from '@prisma/client';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { RuntimeProfileResolver } from '../readiness';
import { TokenSaverService } from '../token-saver/token-saver.service';
import {
  DeepLClient,
  DeepLFailure,
  type DeepLTranslation,
} from './deepl-client';
import {
  lockOwner,
  ownerOfRow,
  ownerWhere,
  readOwnerText,
  type TextOwnerRef,
  writeOwnerText,
} from './text-columns';
import { TextCommands } from './text-commands';
import { type AppliedTextField, TextOwners } from './text-owners';
import { type TextJobData, TextQueue } from './text-queue';

type Tx = Prisma.TransactionClient;

/** A running request with no result this long after it started is a run error. */
export const TEXT_STALE_MS = (TEXT_NORMALIZE_TIMEOUT_SEC + 10 * 60) * 1000;
/** `TEXT_MAX_RUNNING_PER_PROJECT` are running: look again this much later. */
const BUSY_RETRY_MS = 30_000;
/** A run that errored is tried again this much later (D11). */
const RUN_RETRY_DELAY_MS = 5_000;
/** `runs.outcome` is short. */
const OUTCOME_MAX = 500;

export interface TextRequestOptions {
  /** D9: a card whose kind is still `auto` asks for it too. */
  classifyKind?: boolean;
  authorId: string | null;
}

/** The job data a deferred job carries on with (merged into the old). */
export type TextJobPatch = Partial<Omit<TextJobData, 'normalizationId'>>;

/**
 * What one job did; the worker turns `deferred` into a delayed job, with
 * `data` merged into the job's own.
 */
export type NormalizeOutcome =
  | { kind: 'none'; why: string }
  | { kind: 'translated' }
  | { kind: 'skipped'; reason: TextFailReason }
  | { kind: 'failed'; reason: TextFailReason }
  | {
      kind: 'deferred';
      untilMs: number;
      why: 'busy' | 'runner_offline' | 'deepl_retry';
      data?: TextJobPatch;
    }
  | { kind: 'started'; runId: string };

/** One DeepL attempt at a pending request (#324 D1, D2). */
type DeepLAttempt =
  | { ok: true; applied: boolean }
  | { ok: false; error: DeepLError };

/** How a result is applied: what it claims from, and what it records. */
interface ApplyVia {
  from: 'pending' | 'running';
  engine?: 'deepl';
  billedChars?: number;
}

const ACTIVE = ['pending', 'running'] as const;

const parseFields = (value: Prisma.JsonValue): TextField[] => {
  const parsed = textFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

/**
 * Text normalization (issue #271, ADR-0027): the free text a person saves is
 * stored as typed, then replaced by its English text when a small model on
 * the project's runner answers (`text.normalize`, a `runs` row of kind
 * `text_normalize`). One `text_normalizations` row per save keeps the
 * original (D7); a result is applied field by field, only where the column
 * still holds the text it was asked about (D8).
 *
 * With `DEEPL_API_KEY` set (issue #324, ADR-0033), DeepL translates inside
 * the save, within `TEXT_DEEPL_TIMEOUT_MS`, so the save answers with English;
 * a failure leaves the text as typed and the job tries DeepL again, then the
 * runner.
 */
@Injectable()
export class TextNormalizer {
  private readonly logger = new Logger(TextNormalizer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: TextCommands,
    private readonly queue: TextQueue,
    private readonly owners: TextOwners,
    private readonly live: LiveService,
    private readonly profiles: RuntimeProfileResolver,
    private readonly deepl: DeepLClient,
    private readonly tokenSaver: TokenSaverService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /** D13: no row is on. */
  async enabled(projectId: string, db: Tx | PrismaService = this.prisma) {
    const settings = await db.textSettings.findUnique({
      where: { projectId },
      select: { normalizeEnabled: true },
    });
    return settings?.normalizeEnabled ?? true;
  }

  /**
   * D3, D4: one request for the changed fields of one owner, called by the
   * owner's service after its write. Never fails the save: an error is
   * logged and the text stays as typed. Returns the request's id, or `null`
   * when nothing was requested.
   *
   * #324 D1: with DeepL on, it resolves once DeepL's answer is applied (or
   * the attempt failed), so the owner's response, read after it, is English.
   */
  async request(
    projectId: string,
    owner: TextOwnerRef,
    fields: readonly TextFieldInput[],
    options: TextRequestOptions,
  ): Promise<string | null> {
    try {
      return await this.requestOrThrow(projectId, owner, fields, options);
    } catch (error) {
      this.logger.warn(
        `${owner.ownerType} ${owner.ownerId}: normalization not requested: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async requestOrThrow(
    projectId: string,
    owner: TextOwnerRef,
    fields: readonly TextFieldInput[],
    options: TextRequestOptions,
  ): Promise<string | null> {
    if (!(await this.enabled(projectId))) return null;
    const asked = fields.filter((f) => f.text.trim() !== '');
    let classifyKind = options.classifyKind ?? false;
    if (asked.length === 0 && !classifyKind) return null;

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`text:${owner.ownerType}:${owner.ownerId}`}))`;
      // D8: a pending request of the owner is never sent; its fields the
      // new one does not carry ride along, with the column's current text.
      const pending = await tx.textNormalization.findMany({
        where: { ...ownerWhere(owner), status: 'pending' },
        select: { id: true, fields: true, classifyKind: true },
      });
      const merged = new Map(asked.map((f) => [f.field, f.text]));
      if (pending.length > 0) {
        const current = (await readOwnerText(tx, owner)) ?? new Map();
        for (const row of pending) {
          classifyKind ||= row.classifyKind;
          for (const field of parseFields(row.fields)) {
            const text = current.get(field.field);
            if (!merged.has(field.field) && text !== undefined) {
              merged.set(field.field, text);
            }
          }
        }
        await tx.textNormalization.updateMany({
          where: { id: { in: pending.map((r) => r.id) }, status: 'pending' },
          data: { status: 'superseded', finishedAt: new Date() },
        });
      }
      const inputs = [...merged].map(([field, text]) => ({ field, text }));
      if (inputs.length === 0 && !classifyKind) return null;
      const prepared = prepareTextFields(inputs);
      const stored = textFieldsSchema.parse(
        prepared.map(
          (f): TextField => ({
            field: f.id,
            original: f.original,
            sourceHash: textSourceHash(f.original),
            ...(f.skip ? { outcome: 'already_english' } : {}),
          }),
        ),
      );
      const call = needsNormalizeCall(prepared, classifyKind);
      return tx.textNormalization.create({
        data: {
          projectId,
          ownerType: owner.ownerType,
          ...ownerWhere(owner),
          fields: stored,
          classifyKind,
          status: call ? 'pending' : 'done',
          ...(call ? {} : { finishedAt: new Date() }),
          authorId: options.authorId,
        },
        select: { id: true, status: true },
      });
    });
    if (created?.status === 'pending') {
      if (this.deepl.enabled) await this.translateNow(created.id);
      else await this.queue.add(created.id);
    }
    return created?.id ?? null;
  }

  /**
   * #324 D1, D2: DeepL inside the save. A failure leaves the text as typed
   * and hands the request to the job: DeepL again, or straight to the runner
   * when the quota is spent or the key rejected.
   */
  private async translateNow(id: string): Promise<void> {
    const attempt = await this.translateWithDeepL(
      id,
      AbortSignal.timeout(TEXT_DEEPL_TIMEOUT_MS),
    );
    if (attempt.ok) return;
    if (isDeepLFinal(attempt.error)) {
      await this.queue.add(id, 0, { runnerOnly: true });
    } else {
      await this.queue.add(id, RUN_RETRY_DELAY_MS);
    }
  }

  /**
   * #324 D4–D7: one DeepL call for the request's fields, applied like a
   * model's answer. With nothing left to translate (D6) no call is made, and
   * a card's kind is still set by the rule.
   */
  private async translateWithDeepL(
    id: string,
    signal: AbortSignal,
  ): Promise<DeepLAttempt> {
    const row = await this.prisma.textNormalization.findUnique({
      where: { id },
    });
    if (!row || row.status !== 'pending') return { ok: true, applied: false };
    const prepared = prepareTextFields(
      parseFields(row.fields)
        .filter((f) => f.outcome === undefined)
        .map((f) => ({ field: f.field, text: f.original })),
    );
    let translation: DeepLTranslation = { answers: [], billedChars: 0 };
    if (prepared.length > 0) {
      try {
        translation = await this.deepl.translate(
          prepared.map((f) => toDeepLXml(f.masked)),
          signal,
        );
      } catch (error) {
        const failure =
          error instanceof DeepLFailure
            ? error
            : new DeepLFailure('unavailable', 'deepl: call failed');
        await this.prisma.textNormalization.updateMany({
          where: { id, status: 'pending' },
          data: { error: failure.message.slice(0, TEXT_ERROR_MAX) },
        });
        this.logger.warn(`text ${id}: ${failure.message}`);
        return { ok: false, error: failure.kind };
      }
    }
    const applied = await this.apply(
      row,
      new Map(
        resolveDeepLFields(prepared, translation.answers).map((r) => [r.id, r]),
      ),
      'rule',
      prepared.length > 0
        ? {
            from: 'pending',
            engine: 'deepl',
            billedChars: translation.billedChars,
          }
        : { from: 'pending' },
    );
    return { ok: true, applied };
  }

  /** One `text-normalize` job (D4, D11). */
  async process(
    data: TextJobData,
    now: Date = new Date(),
  ): Promise<NormalizeOutcome> {
    const row = await this.prisma.textNormalization.findUnique({
      where: { id: data.normalizationId },
      include: {
        project: {
          select: { id: true, runnerId: true, defaultProfileId: true },
        },
      },
    });
    if (!row || row.status !== 'pending') {
      return { kind: 'none', why: 'not pending' };
    }
    const { project } = row;
    if (!(await this.enabled(project.id))) {
      await this.end(row.id, 'skipped', 'off');
      return { kind: 'skipped', reason: 'off' };
    }

    await this.giveUpStale(project.id, now);

    // #324 D2: DeepL again, with the runs' retry delay; a spent quota, a
    // rejected key or the last retry hands the request to the runner.
    const leg: TextJobPatch = {};
    if (this.deepl.enabled && !data.runnerOnly) {
      const attempt = await this.translateWithDeepL(
        row.id,
        AbortSignal.timeout(TEXT_DEEPL_TIMEOUT_MS),
      );
      if (attempt.ok) {
        return attempt.applied
          ? { kind: 'translated' }
          : { kind: 'none', why: 'not pending' };
      }
      const tried = (data.deeplAttempts ?? 0) + 1;
      if (!isDeepLFinal(attempt.error) && tried < TEXT_RUN_RETRIES) {
        return {
          kind: 'deferred',
          untilMs: now.getTime() + RUN_RETRY_DELAY_MS,
          why: 'deepl_retry',
          data: { deeplAttempts: tried },
        };
      }
      leg.runnerOnly = true;
    }

    const state = this.commands.state(project.runnerId);
    if (state === 'unsupported') {
      await this.end(row.id, 'failed', 'runner_unsupported');
      return { kind: 'failed', reason: 'runner_unsupported' };
    }
    if (state === 'offline') {
      const since = data.offlineSince ?? now.getTime();
      const left = since + TEXT_OFFLINE_GIVE_UP_MS - now.getTime();
      if (left <= 0) {
        await this.end(row.id, 'failed', 'runner_offline');
        return { kind: 'failed', reason: 'runner_offline' };
      }
      const attempts = data.offlineAttempts ?? 0;
      const untilMs =
        now.getTime() + Math.min(textOfflineBackoffMs(attempts), left);
      await this.prisma.textNormalization.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { nextAttemptAt: new Date(untilMs) },
      });
      return {
        kind: 'deferred',
        untilMs,
        why: 'runner_offline',
        data: { ...leg, offlineAttempts: attempts + 1, offlineSince: since },
      };
    }

    // #272 D1 (D12): the orchestrator's profile, else the project default;
    // `claude -p` runs only on a Claude one.
    const pick = await this.profiles.resolve(project);
    if (!pick.ok || pick.profile.runtime !== 'claude') {
      await this.end(row.id, 'failed', 'no_profile');
      return { kind: 'failed', reason: 'no_profile' };
    }
    // Spec 28 D3: a project budget's hard stop; the author's own does not
    // hold back the project's text.
    const budget = await this.budgets?.check({
      projectId: project.id,
      userId: null,
    });
    if (budget && !budget.allowed) {
      await this.end(row.id, 'skipped', 'budget_exceeded');
      return { kind: 'skipped', reason: 'budget_exceeded' };
    }

    const toSend = prepareTextFields(
      parseFields(row.fields)
        .filter((f) => f.outcome === undefined)
        .map((f) => ({ field: f.field, text: f.original })),
    );
    let prompt: string;
    try {
      prompt = buildNormalizePrompt(toSend, row.classifyKind);
    } catch (error) {
      await this.end(row.id, 'failed', 'run_failed', (error as Error).message);
      return { kind: 'failed', reason: 'run_failed' };
    }

    const sessionId = randomUUID();
    // #445 D11: only a runner that advertises the token saver gets the field.
    const saver = await this.tokenSaver.launch(project.id);
    const runId = await this.prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`text-normalize:${project.id}`}))`;
        if (await this.busy(project.id, tx)) return null;
        const run = await tx.run.create({
          data: {
            kind: 'text_normalize',
            projectId: project.id,
            title: 'Text normalization',
            runtime: 'claude',
            model: TEXT_NORMALIZE_MODEL,
            profileKey: pick.profile.key,
            args: {
              normalizationId: row.id,
              ownerType: row.ownerType,
              attempt: row.attempts,
            },
            tokenSaver: saver.on,
            status: 'running',
            triggeredByType: 'user',
            triggeredById: row.authorId,
            startedAt: now,
            updatedAt: now,
          },
          select: { id: true },
        });
        const { count } = await tx.textNormalization.updateMany({
          where: { id: row.id, status: 'pending' },
          data: {
            status: 'running',
            runId: run.id,
            sessionId,
            nextAttemptAt: null,
            // #324 D8: what the runner was sent.
            engine: 'runner',
            billedChars: toSend.reduce((sum, f) => sum + f.masked.length, 0),
          },
        });
        if (count === 0) throw new Superseded();
        return run.id;
      })
      .catch((error: unknown) => {
        if (error instanceof Superseded) return undefined;
        throw error;
      });
    if (runId === undefined) return { kind: 'none', why: 'not pending' };
    if (runId === null) {
      return {
        kind: 'deferred',
        untilMs: now.getTime() + BUSY_RETRY_MS,
        why: 'busy',
        data: leg,
      };
    }
    this.publishRun(project.id, runId, 'running');

    const args: TextNormalizeArgs = {
      runId,
      projectId: project.id,
      sessionId,
      prompt,
      profileKey: pick.profile.key,
      model: TEXT_NORMALIZE_MODEL,
      timeoutSec: TEXT_NORMALIZE_TIMEOUT_SEC,
      ...saver.args,
    };
    let sent: Awaited<ReturnType<TextCommands['normalize']>>;
    try {
      sent = await this.commands.normalize(project.runnerId, args);
    } catch (error) {
      sent = { status: 'error', message: (error as Error).message };
    }
    if (sent.status === 'error') {
      await this.runError(row.id, `runner: ${sent.message}`);
      return { kind: 'failed', reason: 'run_failed' };
    }
    // `unknown`: the runner may have started it; its event, or the stale
    // sweep, settles it.
    return { kind: 'started', runId };
  }

  /**
   * `text_normalize.finished` from `runnerId` (D6, D8, D10). Applied once:
   * only a `running` request of that runner's project is touched.
   */
  async finished(
    runnerId: string,
    data: TextNormalizeFinishedData,
  ): Promise<void> {
    const row = await this.prisma.textNormalization.findFirst({
      where: {
        runId: data.runId,
        projectId: data.projectId,
        project: { runnerId },
      },
    });
    if (!row || row.status !== 'running') return;
    if (!data.ok) {
      await this.runError(row.id, `runner: ${data.error ?? 'failed'}`);
      return;
    }
    if (data.resultTruncated) {
      await this.end(
        row.id,
        'failed',
        'contract_violation',
        'contract_violation: truncated — the result was cut at its limit',
      );
      return;
    }
    const toSend = parseFields(row.fields).filter(
      (f) => f.outcome === undefined,
    );
    const prepared = prepareTextFields(
      toSend.map((f) => ({ field: f.field, text: f.original })),
    );
    const parsed = parseNormalizeOutput(data.result ?? '', {
      ids: prepared.map((f) => f.id),
      classifyKind: row.classifyKind,
    });
    if (!parsed.ok) {
      await this.end(
        row.id,
        'failed',
        'contract_violation',
        textViolationError(parsed),
      );
      return;
    }
    await this.apply(
      row,
      resolvedById(prepared, parsed.output),
      parsed.output.kind,
      { from: 'running' },
    );
  }

  /**
   * D11: an operator runs a failed request again, with the column's current
   * text. Returns `false` when the request is not `failed`.
   */
  async retry(id: string): Promise<boolean> {
    const row = await this.prisma.textNormalization.findUnique({
      where: { id },
    });
    if (!row || row.status !== 'failed') return false;
    const owner = ownerOfRow(row);
    const current = (await readOwnerText(this.prisma, owner)) ?? new Map();
    const inputs = parseFields(row.fields).flatMap((f) => {
      const text = current.get(f.field);
      return text === undefined ? [] : [{ field: f.field, text }];
    });
    const prepared = prepareTextFields(inputs);
    const call = needsNormalizeCall(prepared, row.classifyKind);
    const fields = prepared.map(
      (f): TextField => ({
        field: f.id,
        original: f.original,
        sourceHash: textSourceHash(f.original),
        ...(f.skip ? { outcome: 'already_english' } : {}),
      }),
    );
    if (fields.length === 0 && !row.classifyKind) {
      await this.prisma.textNormalization.updateMany({
        where: { id, status: 'failed' },
        data: { status: 'done', failReason: null, error: null },
      });
      return true;
    }
    const { count } = await this.prisma.textNormalization.updateMany({
      where: { id, status: 'failed' },
      data: {
        fields: textFieldsSchema.parse(fields),
        status: call ? 'pending' : 'done',
        failReason: null,
        error: null,
        attempts: 0,
        nextAttemptAt: null,
        finishedAt: call ? null : new Date(),
      },
    });
    if (count === 0) return false;
    if (call) await this.queue.add(id);
    await this.changed(row.projectId, owner);
    return true;
  }

  /**
   * D13: switching off skips what has not run; a running request still
   * lands, since its text was sent already.
   */
  async skipPending(projectId: string): Promise<void> {
    await this.prisma.textNormalization.updateMany({
      where: { projectId, status: 'pending' },
      data: { status: 'skipped', failReason: 'off', finishedAt: new Date() },
    });
  }

  /**
   * D8, D9, D10: the result, field by field, under the owner's row lock.
   * `kind` is the model's answer, or `rule` (#324 D7): the English rule on
   * the card's text as it now stands. Returns whether it was applied.
   */
  private async apply(
    row: TextNormalization,
    resolved: ReadonlyMap<string, ResolvedTextField>,
    kindOf: BoardCardKind | 'rule' | undefined,
    via: ApplyVia,
  ): Promise<boolean> {
    const owner = ownerOfRow(row);
    const now = new Date();
    const done = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.textNormalization.updateMany({
        where: { id: row.id, status: via.from },
        data: { status: 'done', finishedAt: now },
      });
      if (claimed.count === 0) return false;
      await lockOwner(tx, owner);
      const current = (await readOwnerText(tx, owner)) ?? new Map();
      const writes = new Map<string, string>();
      const applied: AppliedTextField[] = [];
      const fields = parseFields(row.fields).map((field): TextField => {
        if (field.outcome !== undefined) return field;
        const result = resolved.get(field.field);
        if (!result) return { ...field, outcome: 'already_english' };
        const text = current.get(field.field);
        const moved =
          text === undefined || textSourceHash(text) !== field.sourceHash;
        if (result.outcome !== 'translated') {
          return { ...field, outcome: moved ? 'superseded' : result.outcome };
        }
        // D8: the person edited it meanwhile; their edit wins.
        if (moved) return { ...field, outcome: 'superseded' };
        writes.set(field.field, result.english);
        applied.push({
          field: field.field,
          original: field.original,
          english: result.english,
        });
        return { ...field, outcome: 'translated', english: result.english };
      });
      await writeOwnerText(tx, owner, writes);
      await this.owners.derive(tx, owner.ownerType, owner.ownerId, applied);
      const textOf = (field: string) =>
        writes.get(field) ?? current.get(field) ?? '';
      const kind =
        kindOf !== 'rule'
          ? kindOf
          : row.classifyKind && owner.ownerType === 'board_card'
            ? classifyCardKindEnglish(textOf('title'), textOf('body'))
            : undefined;
      if (kind !== undefined && row.classifyKind && row.cardId !== null) {
        // D9: never over a person's kind, nor once a Run fixed the branch.
        await tx.boardCard.updateMany({
          where: { id: row.cardId, kindSource: 'auto', branch: null },
          data: { kind },
        });
      }
      await tx.textNormalization.update({
        where: { id: row.id },
        data: {
          fields: textFieldsSchema.parse(fields),
          ...(kind !== undefined ? { kind } : {}),
          ...(via.engine !== undefined
            ? { engine: via.engine, billedChars: via.billedChars ?? null }
            : {}),
        },
      });
      if (row.runId) {
        await this.closeRun(
          tx,
          row.runId,
          'succeeded',
          `${applied.length} translated`,
        );
      }
      return true;
    });
    if (!done) return false;
    if (row.runId) this.publishRun(row.projectId, row.runId, 'succeeded');
    await this.changed(row.projectId, owner, { settled: true });
    return true;
  }

  /**
   * D11: a run that errored or timed out is tried again, at most
   * `TEXT_RUN_RETRIES` times; then the request is `failed: run_failed`.
   */
  private async runError(id: string, error: string): Promise<void> {
    const message = error.slice(0, TEXT_ERROR_MAX);
    const ended = await this.prisma.$transaction(async (tx) => {
      const row = await tx.textNormalization.findUnique({
        where: { id },
        select: { status: true, attempts: true, runId: true, projectId: true },
      });
      if (!row || row.status !== 'running') return null;
      const attempts = row.attempts + 1;
      const again = attempts <= TEXT_RUN_RETRIES;
      await tx.textNormalization.update({
        where: { id },
        data: again
          ? { status: 'pending', attempts, error: message }
          : {
              status: 'failed',
              attempts,
              failReason: 'run_failed',
              error: message,
              finishedAt: new Date(),
            },
      });
      if (row.runId) await this.closeRun(tx, row.runId, 'failed', message);
      return { ...row, again };
    });
    if (!ended) return;
    if (ended.runId) this.publishRun(ended.projectId, ended.runId, 'failed');
    if (ended.again) {
      // #324 D2: a run's retry stays on the runner.
      await this.queue.add(id, RUN_RETRY_DELAY_MS, { runnerOnly: true });
      return;
    }
    await this.changedById(id);
  }

  /** Ends a pending or running request as `failed` / `skipped`, once. */
  private async end(
    id: string,
    status: 'failed' | 'skipped',
    reason: TextFailReason,
    error?: string,
  ): Promise<void> {
    const ended = await this.prisma.$transaction(async (tx) => {
      const row = await tx.textNormalization.findUnique({
        where: { id },
        select: { runId: true, projectId: true, status: true },
      });
      const { count } = await tx.textNormalization.updateMany({
        where: { id, status: { in: [...ACTIVE] } },
        data: {
          status,
          failReason: reason,
          finishedAt: new Date(),
          ...(error !== undefined
            ? { error: error.slice(0, TEXT_ERROR_MAX) }
            : {}),
        },
      });
      if (count === 0 || !row) return null;
      if (row.runId && row.status === 'running') {
        await this.closeRun(tx, row.runId, 'failed', error ?? reason);
        return row;
      }
      return { ...row, runId: null };
    });
    if (!ended) return;
    if (ended.runId) this.publishRun(ended.projectId, ended.runId, 'failed');
    await this.changedById(id);
  }

  /** A running request whose result never came is a run error. */
  private async giveUpStale(projectId: string, now: Date): Promise<void> {
    const stale = await this.prisma.textNormalization.findMany({
      where: {
        projectId,
        status: 'running',
        run: { startedAt: { lt: new Date(now.getTime() - TEXT_STALE_MS) } },
      },
      select: { id: true },
    });
    for (const row of stale) {
      await this.runError(row.id, 'no result from the runner');
    }
  }

  /** D11: at most `TEXT_MAX_RUNNING_PER_PROJECT` running per project. */
  private async busy(projectId: string, db: Tx): Promise<boolean> {
    const running = await db.textNormalization.count({
      where: { projectId, status: 'running' },
    });
    return running >= TEXT_MAX_RUNNING_PER_PROJECT;
  }

  private async closeRun(
    tx: Tx,
    runId: string,
    status: RunStatus,
    outcome: string,
  ): Promise<void> {
    const run = await tx.run.findUnique({
      where: { id: runId },
      select: { startedAt: true, endedAt: true },
    });
    if (!run || run.endedAt !== null) return;
    const now = new Date();
    await tx.run.update({
      where: { id: runId },
      data: {
        status,
        endedAt: now,
        durationMs: now.getTime() - run.startedAt.getTime(),
        updatedAt: now,
        outcome: outcome.slice(0, OUTCOME_MAX),
      },
    });
  }

  private publishRun(projectId: string, runId: string, status: RunStatus) {
    const change: RunLiveChange = { id: runId, status };
    try {
      this.live.publish(`project:${projectId}`, RUN_UPDATED_LIVE_EVENT, change);
    } catch (error) {
      this.logger.warn(
        `run.updated ${runId} not published: ${(error as Error).message}`,
      );
    }
  }

  /** A request that ended for good: failed past its retries, or skipped. */
  private async changedById(id: string): Promise<void> {
    const row = await this.prisma.textNormalization.findUnique({
      where: { id },
    });
    if (row) {
      await this.changed(row.projectId, ownerOfRow(row), { settled: true });
    }
  }

  /**
   * The owner's own live event, and `text.changed` (API section). `settled`:
   * the request ended for good, and the owner's `settled` hook runs too.
   */
  private async changed(
    projectId: string,
    owner: TextOwnerRef,
    { settled = false }: { settled?: boolean } = {},
  ) {
    await this.owners.publish(owner.ownerType, projectId, owner.ownerId);
    if (settled) {
      await this.owners.settled(owner.ownerType, projectId, owner.ownerId);
    }
    const data: TextChangedData = { ...owner };
    try {
      this.live.publish(`project:${projectId}`, TEXT_CHANGED_EVENT, data);
    } catch (error) {
      this.logger.warn(
        `text.changed not published: ${(error as Error).message}`,
      );
    }
  }
}

/** The claim failed: a newer request superseded this one meanwhile. */
class Superseded extends Error {}

const resolvedById = (
  ...args: Parameters<typeof resolveNormalizedFields>
): Map<string, ResolvedTextField> =>
  new Map(resolveNormalizedFields(...args).map((r) => [r.id, r]));
