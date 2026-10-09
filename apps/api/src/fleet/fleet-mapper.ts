import type {
  BoardErrorView,
  OrchestratorView,
  RoundHeader,
  RoundView,
  SlotCheckpointView,
  SlotDetail,
  SlotSummary,
} from '@agentdock/shared';
import type { RoundDecisions } from '@agentdock/shared/protocol';
import type {
  FleetOrchestrator,
  Prisma,
  Round,
  Slot,
  SlotCheckpoint,
} from '@prisma/client';

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

const strings = (value: Prisma.JsonValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

export const toSlotSummary = (row: Slot): SlotSummary => ({
  id: row.id,
  name: row.name,
  issue: row.issue,
  branch: row.branch,
  runtime: row.runtime,
  model: row.model,
  modelWhy: row.modelWhy,
  lead: row.lead,
  status: row.status,
  round: row.round,
  lastCheckpoint: row.lastCheckpoint,
  prNumber: row.prNumber,
  prUrl: row.prUrl,
  prChecks: row.prChecks,
  ahead: row.ahead,
  behind: row.behind,
  dirty: row.dirty,
  startedAt: row.startedAt.toISOString(),
  endedAt: iso(row.endedAt),
  updatedAt: row.updatedAt.toISOString(),
});

export const toCheckpointView = (row: SlotCheckpoint): SlotCheckpointView => ({
  id: row.id,
  kind: row.kind,
  heading: row.heading,
  summary: row.summary,
  position: row.position,
  at: row.at.toISOString(),
});

export const toSlotDetail = (
  row: Slot & { checkpoints: SlotCheckpoint[] },
): SlotDetail => ({
  ...toSlotSummary(row),
  worktree: row.worktree,
  owns: strings(row.owns),
  never: strings(row.never),
  sessionAlive: row.sessionAlive === true,
  pane: row.pane,
  worktreeExists: row.worktreeExists,
  prState: row.prState,
  prMergeable: row.prMergeable,
  checkpoints: row.checkpoints.map(toCheckpointView),
});

export const toRoundHeader = (row: Round): RoundHeader => ({
  id: row.id,
  date: row.date.toISOString().slice(0, 10),
  label: row.label,
  base: row.base,
  occupied: row.occupied,
  max: row.max,
  free: row.free,
  source: row.source,
  boardPath: row.boardPath,
  createdAt: row.createdAt.toISOString(),
});

export const toRoundView = (row: Round): RoundView => ({
  ...toRoundHeader(row),
  decisions: row.decisions as unknown as RoundDecisions,
});

export const toOrchestratorView = (
  row: FleetOrchestrator | null,
): OrchestratorView => ({
  status: row?.status ?? 'unknown',
  session: row?.session ?? null,
  since: iso(row?.since ?? null),
});

export const toBoardError = (
  row: FleetOrchestrator | null,
): BoardErrorView | null =>
  (row?.boardError as unknown as BoardErrorView | null | undefined) ?? null;
