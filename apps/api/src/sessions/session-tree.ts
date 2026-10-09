import type {
  SessionRequestNode,
  SessionSummary,
  SessionToolNode,
  SessionTotals,
  SessionTreeNode,
  SessionTurnNode,
} from '@agentdock/shared';
import type { QuerySource, Runtime } from '@agentdock/shared/protocol';
import type { Prisma } from '@prisma/client';

export interface SessionRow {
  id: string;
  runnerId: string;
  runtime: Runtime;
  profileKey: string | null;
  externalId: string;
  projectId: string | null;
  projectName: string | null;
  slotName: string | null;
  cwd: string;
  gitBranch: string | null;
  title: string | null;
  models: unknown;
  parentSessionId: string | null;
  parsed: boolean;
  startedAt: Date;
  lastEventAt: Date;
  endedAt: Date | null;
}

export interface TurnRow {
  id: string;
  sessionId: string;
  promptId: string;
  startedAt: Date;
  endedAt: Date | null;
}

export interface RequestRow {
  id: string;
  sessionId: string;
  turnId: string | null;
  requestId: string;
  ts: Date;
  model: string;
  querySource: QuerySource;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  reasoning: number;
  durationMs: number | null;
  durationApprox: boolean;
  stopReason: string | null;
  costUsd: Prisma.Decimal | null;
}

export interface ToolRow {
  id: string;
  sessionId: string;
  turnId: string | null;
  toolUseId: string;
  name: string;
  startedAt: Date;
  endedAt: Date | null;
  ok: boolean | null;
  childSessionId: string | null;
}

/** Everything under one root session, as loaded from the database. */
export interface SubtreeRows {
  sessions: SessionRow[];
  turns: TurnRow[];
  requests: RequestRow[];
  tools: ToolRow[];
}

/** Totals while summing: cost stays a Decimal until the node is done. */
interface Sum {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  reasoning: number;
  requests: number;
  costUsd: Prisma.Decimal | null;
}

const zero = (): Sum => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  requests: 0,
  costUsd: null,
});

const add = (into: Sum, more: Sum): Sum => {
  into.input += more.input;
  into.output += more.output;
  into.cacheRead += more.cacheRead;
  into.cacheWrite5m += more.cacheWrite5m;
  into.cacheWrite1h += more.cacheWrite1h;
  into.reasoning += more.reasoning;
  into.requests += more.requests;
  if (more.costUsd !== null) {
    into.costUsd =
      into.costUsd === null ? more.costUsd : into.costUsd.add(more.costUsd);
  }
  return into;
};

const ofRequest = (r: RequestRow): Sum => ({
  input: r.input,
  output: r.output,
  cacheRead: r.cacheRead,
  cacheWrite5m: r.cacheWrite5m,
  cacheWrite1h: r.cacheWrite1h,
  reasoning: r.reasoning,
  requests: 1,
  costUsd: r.costUsd,
});

const totals = (sum: Sum): SessionTotals => ({
  ...sum,
  costUsd: sum.costUsd === null ? null : sum.costUsd.toString(),
});

/** A Json `models` column as a list of strings, whatever it holds. */
export const modelList = (models: unknown): string[] =>
  Array.isArray(models)
    ? models.filter((m): m is string => typeof m === 'string')
    : [];

const groupBy = <T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> => {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
};

const byTime =
  <T>(time: (row: T) => Date) =>
  (a: T, b: T) =>
    time(a).getTime() - time(b).getTime();

/** The summary fields that do not depend on the tree. */
export const summaryOf = (
  row: SessionRow,
  counts: Pick<SessionSummary, 'turns' | 'toolCalls' | 'subagents'>,
  sessionTotals: SessionTotals,
): SessionSummary => ({
  id: row.id,
  runnerId: row.runnerId,
  runtime: row.runtime,
  profileKey: row.profileKey,
  externalId: row.externalId,
  projectId: row.projectId,
  projectName: row.projectName,
  slotName: row.slotName,
  cwd: row.cwd,
  gitBranch: row.gitBranch,
  title: row.title,
  models: modelList(row.models),
  parentSessionId: row.parentSessionId,
  parsed: row.parsed,
  startedAt: row.startedAt.toISOString(),
  lastEventAt: row.lastEventAt.toISOString(),
  endedAt: row.endedAt?.toISOString() ?? null,
  durationMs: Math.max(
    0,
    (row.endedAt ?? row.lastEventAt).getTime() - row.startedAt.getTime(),
  ),
  ...counts,
  totals: sessionTotals,
});

/**
 * Builds the tree under `rootId`. A subagent session sits under the tool call
 * that spawned it when one in the tree links it, else in its parent's
 * `subagents`; each session appears once. Every node's totals are the sum of
 * its children's, so the root's totals are the whole tree's.
 */
export const buildSessionTree = (
  rootId: string,
  rows: SubtreeRows,
): SessionTreeNode | null => {
  const sessions = new Map(rows.sessions.map((s) => [s.id, s]));
  const turnsBySession = groupBy(rows.turns, (t) => t.sessionId);
  const requestsBySession = groupBy(rows.requests, (r) => r.sessionId);
  const toolsBySession = groupBy(rows.tools, (t) => t.sessionId);
  const childrenOf = groupBy(
    rows.sessions.filter((s) => s.parentSessionId !== null),
    (s) => s.parentSessionId,
  );
  const placed = new Set<string>();

  const requestNode = (r: RequestRow): SessionRequestNode => ({
    id: r.id,
    requestId: r.requestId,
    ts: r.ts.toISOString(),
    model: r.model,
    querySource: r.querySource,
    durationMs: r.durationMs,
    durationApprox: r.durationApprox,
    stopReason: r.stopReason,
    totals: totals(ofRequest(r)),
  });

  const build = (row: SessionRow): { node: SessionTreeNode; sum: Sum } => {
    placed.add(row.id);
    let subagents = 0;
    const sessionSum = zero();

    const toolNode = (t: ToolRow): { node: SessionToolNode; sum: Sum } => {
      const childRow =
        t.childSessionId !== null && !placed.has(t.childSessionId)
          ? sessions.get(t.childSessionId)
          : undefined;
      const child = childRow ? build(childRow) : null;
      if (child) subagents += 1 + child.node.session.subagents;
      const sum = child ? child.sum : zero();
      return {
        node: {
          id: t.id,
          toolUseId: t.toolUseId,
          name: t.name,
          startedAt: t.startedAt.toISOString(),
          endedAt: t.endedAt?.toISOString() ?? null,
          ok: t.ok,
          child: child?.node ?? null,
          totals: totals(sum),
        },
        sum,
      };
    };

    const requests = (requestsBySession.get(row.id) ?? []).sort(
      byTime((r) => r.ts),
    );
    const tools = (toolsBySession.get(row.id) ?? []).sort(
      byTime((t) => t.startedAt),
    );
    const turnRows = (turnsBySession.get(row.id) ?? []).sort(
      byTime((t) => t.startedAt),
    );
    const turnIds = new Set(turnRows.map((t) => t.id));
    const inTurn = (turnId: string | null) =>
      turnId !== null && turnIds.has(turnId);

    const turns: SessionTurnNode[] = turnRows.map((turn) => {
      const sum = zero();
      const turnRequests = requests
        .filter((r) => r.turnId === turn.id)
        .map((r) => {
          add(sum, ofRequest(r));
          return requestNode(r);
        });
      const turnTools = tools
        .filter((t) => t.turnId === turn.id)
        .map((t) => {
          const built = toolNode(t);
          add(sum, built.sum);
          return built.node;
        });
      add(sessionSum, sum);
      return {
        id: turn.id,
        promptId: turn.promptId,
        startedAt: turn.startedAt.toISOString(),
        endedAt: turn.endedAt?.toISOString() ?? null,
        requests: turnRequests,
        tools: turnTools,
        totals: totals(sum),
      };
    });

    const unattributed = {
      requests: requests
        .filter((r) => !inTurn(r.turnId))
        .map((r) => {
          add(sessionSum, ofRequest(r));
          return requestNode(r);
        }),
      tools: tools
        .filter((t) => !inTurn(t.turnId))
        .map((t) => {
          const built = toolNode(t);
          add(sessionSum, built.sum);
          return built.node;
        }),
    };

    const unlinked = (childrenOf.get(row.id) ?? [])
      .filter((c) => !placed.has(c.id))
      .sort(byTime((c) => c.startedAt))
      .map((c) => {
        const built = build(c);
        subagents += 1 + built.node.session.subagents;
        add(sessionSum, built.sum);
        return built.node;
      });

    const sessionTotals = totals(sessionSum);
    return {
      node: {
        session: summaryOf(
          row,
          { turns: turnRows.length, toolCalls: tools.length, subagents },
          sessionTotals,
        ),
        turns,
        unattributed,
        subagents: unlinked,
        totals: sessionTotals,
      },
      sum: sessionSum,
    };
  };

  const root = sessions.get(rootId);
  return root ? build(root).node : null;
};
