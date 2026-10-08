import {
  branchIssue,
  comparePriority,
  IN_FLIGHT_LABEL,
  NEEDS_PERSON_LABEL,
  parseClosingRefs,
  parseDependsOn,
  parseGate,
  parseParallelPlan,
  priorityOf,
  type QueuePriority,
  type QueueSource,
  type QueueVerdict,
  SPEC_GAP_TEXT,
  specGap,
  type WaveSlot,
} from '@agentdock/shared';

/** An `issues_cache` row, as the computation reads it. */
export interface CachedIssue {
  number: number;
  kind: 'issue' | 'pull_request';
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  body: string;
  closedBy: 'pr' | 'manual' | null;
  /** When the row's content last changed (D4). */
  snapshotAt: Date;
}

/** A slot from the fleet projection (#11). */
export interface QueueSlot {
  name: string;
  issue: number | null;
  branch: string | null;
  /** Not `ended`: running, idle, stale — a slot the orchestrator resumes. */
  live: boolean;
}

/** The latest round's verdicts (D4). */
export interface QueueRound {
  updatedAt: Date;
  verdicts: ReadonlyMap<number, QueueVerdict>;
}

export interface QueueInputs {
  readyLabel: string;
  /** Issues and pull requests, open and closed. */
  issues: CachedIssue[];
  slots: QueueSlot[];
  round: QueueRound | null;
}

export interface ComputedQueueItem {
  number: number;
  /** AgentDock's own D3 verdict. */
  computed: QueueVerdict;
  /** The orchestrator's verdict from the latest round, fresher or not. */
  orchestrator: QueueVerdict | null;
  /** Which of the two is shown (D4). */
  source: QueueSource;
  shown: QueueVerdict;
  /** `Depends on` issues that still block it. */
  blockers: number[];
  waveSlots: WaveSlot[] | null;
  priority: QueuePriority | null;
}

const hasLabel = (labels: readonly string[], label: string): boolean =>
  labels.some((l) => l.toLowerCase() === label.toLowerCase());

/** Whether an issue carries the ready label — GitHub label names ignore case. */
export const isReady = (issue: CachedIssue, readyLabel: string): boolean =>
  issue.kind === 'issue' &&
  issue.state === 'open' &&
  hasLabel(issue.labels, readyLabel);

const refs = (numbers: number[]): string =>
  numbers.map((n) => `#${n}`).join(', ');

interface Context {
  byNumber: ReadonlyMap<number, CachedIssue>;
  /** Issue → the open pull requests whose body closes it. */
  closingPrs: ReadonlyMap<number, number[]>;
  slots: QueueSlot[];
}

const inFlight = (issue: CachedIssue, ctx: Context): QueueVerdict | null => {
  const prs = ctx.closingPrs.get(issue.number);
  if (prs) {
    return {
      state: 'in_flight',
      why: `pull request ${refs(prs)} closes it`,
      clears: null,
    };
  }
  const slot = ctx.slots.find(
    (s) =>
      s.live &&
      (s.issue === issue.number ||
        (s.branch !== null && branchIssue(s.branch) === issue.number)),
  );
  if (slot) {
    return {
      state: 'in_flight',
      why: `slot ${slot.name} carries it`,
      clears: null,
    };
  }
  if (hasLabel(issue.labels, IN_FLIGHT_LABEL)) {
    return {
      state: 'in_flight',
      why: `labelled ${IN_FLIGHT_LABEL}`,
      clears: null,
    };
  }
  return null;
};

const blockedOnPerson = (issue: CachedIssue): QueueVerdict | null => {
  if (hasLabel(issue.labels, NEEDS_PERSON_LABEL)) {
    return {
      state: 'blocked_person',
      why: `labelled ${NEEDS_PERSON_LABEL}`,
      clears: `a person answers it and removes ${NEEDS_PERSON_LABEL}`,
    };
  }
  const gate = parseGate(issue.body);
  if (gate) {
    return {
      state: 'blocked_person',
      why: gate,
      clears: 'a person clears the gate',
    };
  }
  return null;
};

/** Why a dependency still blocks, or null once a merged pull request closed it. */
const dependencyBlock = (
  dependency: CachedIssue | undefined,
): string | null => {
  if (dependency?.state === 'open') return 'is open';
  if (dependency?.closedBy === 'pr') return null;
  if (dependency?.closedBy === 'manual')
    return 'was closed without a merged pull request';
  return 'is closed; how is not known yet';
};

const blockedOnWork = (
  issue: CachedIssue,
  ctx: Context,
): { verdict: QueueVerdict; blockers: number[] } | null => {
  const blocks = parseDependsOn(issue.body).flatMap((m) => {
    const reason = dependencyBlock(ctx.byNumber.get(m));
    return reason ? [{ number: m, reason }] : [];
  });
  if (blocks.length === 0) return null;
  const blockers = blocks.map((b) => b.number);
  return {
    blockers,
    verdict: {
      state: 'blocked_work',
      why: blocks
        .map((b) => `depends on #${b.number}, which ${b.reason}`)
        .join('; '),
      clears: `${refs(blockers)} closed by a merged pull request`,
    },
  };
};

const noSpec = (issue: CachedIssue): QueueVerdict | null => {
  const gap = specGap(issue.body, issue.labels);
  return gap ? { state: 'no_spec', ...SPEC_GAP_TEXT[gap] } : null;
};

/** D3, in its precedence order. */
const compute = (
  issue: CachedIssue,
  ctx: Context,
): { verdict: QueueVerdict; blockers: number[] } => {
  const flight = inFlight(issue, ctx);
  if (flight) return { verdict: flight, blockers: [] };
  const person = blockedOnPerson(issue);
  if (person) return { verdict: person, blockers: [] };
  const work = blockedOnWork(issue, ctx);
  if (work) return work;
  const spec = noSpec(issue);
  if (spec) return { verdict: spec, blockers: [] };
  const deps = parseDependsOn(issue.body);
  return {
    verdict: {
      state: 'ready',
      why:
        deps.length > 0
          ? `${refs(deps)} merged; nothing else blocks it`
          : 'nothing blocks it',
      clears: null,
    },
    blockers: [],
  };
};

/**
 * The queue of one project (spec 19 D3, D4, D6): every open issue with the
 * ready label, its state computed the way the orchestrator's Phase 2 does,
 * replaced by the orchestrator's own verdict when its latest round is newer
 * than the issue's last change. Pure: the caller loads the inputs.
 */
export const computeQueue = (inputs: QueueInputs): ComputedQueueItem[] => {
  const byNumber = new Map(inputs.issues.map((i) => [i.number, i]));
  const closingPrs = new Map<number, number[]>();
  for (const pr of inputs.issues) {
    if (pr.kind !== 'pull_request' || pr.state !== 'open') continue;
    for (const n of parseClosingRefs(pr.body)) {
      closingPrs.set(n, [...(closingPrs.get(n) ?? []), pr.number]);
    }
  }
  const ctx: Context = { byNumber, closingPrs, slots: inputs.slots };

  return inputs.issues
    .filter((issue) => isReady(issue, inputs.readyLabel))
    .map((issue) => {
      const { verdict, blockers } = compute(issue, ctx);
      const orchestrator = inputs.round?.verdicts.get(issue.number) ?? null;
      const fresher =
        orchestrator !== null &&
        inputs.round !== null &&
        inputs.round.updatedAt > issue.snapshotAt;
      return {
        number: issue.number,
        computed: verdict,
        orchestrator,
        source: fresher ? 'orchestrator' : 'computed',
        shown: fresher && orchestrator ? orchestrator : verdict,
        blockers,
        waveSlots: parseParallelPlan(issue.body),
        priority: priorityOf(issue.labels),
      } satisfies ComputedQueueItem;
    })
    .sort(comparePriority);
};
