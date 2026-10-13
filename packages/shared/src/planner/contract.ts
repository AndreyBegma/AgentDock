import type { z } from 'zod';
import {
  isPlannedTask,
  PLANNER_BLOCK_TAG,
  PLANNER_CONTRACT_VERSION,
  PLANNER_MAX_OPTIONS,
  PLANNER_MAX_QUESTIONS,
  PLANNER_MAX_TASKS,
  type PlannedTask,
  type PlannerOutput,
  type PlanTaskKind,
  type PlanTurnAction,
  plannerOutputSchemas,
} from './types';

/**
 * The output contract, v1 (docs/specs/172-planner.md "Output contract",
 * D17). The API extracts the one `agentdock-plan` block of a turn's final
 * message and validates it here. A turn that fails is `contract_violation`
 * and applies nothing, so `reason` exists to say why — not to recover.
 */

export const PLANNER_VIOLATION_REASONS = [
  /** No `agentdock-plan` block, or one that is never closed. */
  'no_block',
  /** Two or more `agentdock-plan` blocks. */
  'multiple_blocks',
  'invalid_json',
  /** The block's `action` is not the action the turn asked for. */
  'action_mismatch',
  /** A key the contract does not name, at any depth. */
  'unknown_key',
  /** More than `PLANNER_MAX_TASKS` tasks. */
  'too_many_tasks',
  /** More than `PLANNER_MAX_QUESTIONS` questions in a round. */
  'too_many_questions',
  /** Any other shape error: a missing field, a wrong type, a bad id. */
  'invalid_shape',
  /** Two tasks with one key. */
  'duplicate_task_key',
  /** `dependsOn` names a key that is not a task of the plan. */
  'unknown_dependency',
  /** A task depends on itself. */
  'self_dependency',
  /** `taskKey` is not the task the turn was about. */
  'task_mismatch',
  /** Revise: a frozen task is missing, changed, or a `{ key }` names no frozen task. */
  'frozen_task',
  /** A feature document without `## Acceptance criteria`. */
  'missing_acceptance_criteria',
  /** A bug document without `## Reproduction`. */
  'missing_reproduction',
] as const;
export type PlannerViolationReason = (typeof PLANNER_VIOLATION_REASONS)[number];

export interface PlannerContractViolation {
  code: 'contract_violation';
  reason: PlannerViolationReason;
  message: string;
}

export type PlannerParseResult<A extends PlanTurnAction> =
  | { ok: true; output: PlannerOutput<A> }
  | { ok: false; error: PlannerContractViolation };

/** What the API knows about the turn that the output alone cannot say. */
export interface PlannerParseContexts {
  clarify: undefined;
  decompose: undefined;
  /** The task the grill turn was about. */
  grill: { taskKey: string };
  /** The task, and its kind: it decides which heading the document needs. */
  write: { taskKey: string; taskKind: PlanTaskKind };
  /** The keys of the approved tasks, which must pass through unchanged (D9). */
  revise: { frozenKeys: readonly string[] };
}

type ContextArgs<A extends PlanTurnAction> =
  PlannerParseContexts[A] extends undefined ? [] : [PlannerParseContexts[A]];

const violation = (
  reason: PlannerViolationReason,
  message: string,
): { ok: false; error: PlannerContractViolation } => ({
  ok: false,
  error: { code: 'contract_violation', reason, message },
});

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The contents of every fenced block tagged `agentdock-plan` (CommonMark
 * fences: ``` or ~~~, closed by a fence of the same character at least as
 * long). Other fenced blocks are skipped whole, so a tag quoted inside one is
 * not a block. `null` marks a tagged block that is never closed.
 */
export const extractPlannerBlocks = (text: string): (string | null)[] => {
  const blocks: (string | null)[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      i += 1;
      continue;
    }
    const fence = open[1];
    const info = open[2].trim().split(/\s+/)[0] ?? '';
    // A backtick fence's info string may not contain a backtick.
    if (fence[0] === '`' && open[2].includes('`')) {
      i += 1;
      continue;
    }
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
    const body: string[] = [];
    let closed = false;
    i += 1;
    while (i < lines.length) {
      if (close.test(lines[i])) {
        closed = true;
        i += 1;
        break;
      }
      body.push(lines[i]);
      i += 1;
    }
    if (info === PLANNER_BLOCK_TAG)
      blocks.push(closed ? body.join('\n') : null);
  }
  return blocks;
};

type Issue = z.core.$ZodIssue;

/** Zod issues with every union branch's issues flattened in. */
const flattenIssues = (issues: readonly Issue[]): Issue[] =>
  issues.flatMap((issue) =>
    issue.code === 'invalid_union'
      ? [issue, ...issue.errors.flatMap((branch) => flattenIssues(branch))]
      : [issue],
  );

const formatPath = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? '(root)' : path.map(String).join('.');

const shapeViolation = (issues: readonly Issue[]) => {
  const all = flattenIssues(issues);
  const unknown = all.find((i) => i.code === 'unrecognized_keys');
  if (unknown?.code === 'unrecognized_keys') {
    return violation(
      'unknown_key',
      `unknown key at ${formatPath(unknown.path)}: ${unknown.keys.join(', ')}`,
    );
  }
  const tooBig = all.filter((i) => i.code === 'too_big');
  const lastKey = (i: Issue) => i.path[i.path.length - 1];
  const tasks = tooBig.find((i) => lastKey(i) === 'tasks');
  if (tasks) {
    return violation(
      'too_many_tasks',
      `a plan has at most ${PLANNER_MAX_TASKS} tasks`,
    );
  }
  const questions = tooBig.find((i) => lastKey(i) === 'questions');
  if (questions) {
    return violation(
      'too_many_questions',
      `a round has at most ${PLANNER_MAX_QUESTIONS} questions (${formatPath(questions.path)})`,
    );
  }
  const first = all.find((i) => i.code !== 'invalid_union') ?? all[0];
  return violation(
    'invalid_shape',
    first ? `${formatPath(first.path)}: ${first.message}` : 'invalid output',
  );
};

/** Unique keys, no self-dependency, every `dependsOn` a key of the plan. */
const checkTaskGraph = (
  tasks: readonly PlannedTask[],
  allKeys: readonly string[],
) => {
  const seen = new Set<string>();
  for (const key of allKeys) {
    if (seen.has(key)) {
      return violation('duplicate_task_key', `two tasks have the key ${key}`);
    }
    seen.add(key);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.key) {
        return violation(
          'self_dependency',
          `task ${task.key} depends on itself`,
        );
      }
      if (!seen.has(dep)) {
        return violation(
          'unknown_dependency',
          `task ${task.key} depends on ${dep}, which is not a task of this plan`,
        );
      }
    }
  }
  return null;
};

const hasHeading = (document: string, heading: string): boolean =>
  new RegExp(`^##[ \\t]+${heading}[ \\t]*#*[ \\t]*$`, 'im').test(document);

/** The heading each kind's document must carry (D4). */
export const PLANNER_REQUIRED_HEADING: Record<PlanTaskKind, string> = {
  feature: 'Acceptance criteria',
  bug: 'Reproduction',
};

/**
 * Validates a turn's final message against the v1 contract for `action`.
 * `grill`, `write` and `revise` take the context only the API knows.
 */
export function parsePlannerOutput<A extends PlanTurnAction>(
  text: string,
  action: A,
  ...context: ContextArgs<A>
): PlannerParseResult<A>;
export function parsePlannerOutput(
  text: string,
  action: PlanTurnAction,
  context?: PlannerParseContexts[PlanTurnAction],
): PlannerParseResult<PlanTurnAction> {
  const blocks = extractPlannerBlocks(text);
  if (blocks.length > 1) {
    return violation(
      'multiple_blocks',
      `expected one ${PLANNER_BLOCK_TAG} block, found ${blocks.length}`,
    );
  }
  const block = blocks[0];
  if (block === undefined || block === null) {
    return violation(
      'no_block',
      block === null
        ? `the ${PLANNER_BLOCK_TAG} block is never closed`
        : `no ${PLANNER_BLOCK_TAG} block`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(block);
  } catch (error) {
    return violation(
      'invalid_json',
      error instanceof Error ? error.message : 'not JSON',
    );
  }
  if (
    typeof json === 'object' &&
    json !== null &&
    'action' in json &&
    json.action !== action
  ) {
    return violation(
      'action_mismatch',
      `expected action ${action}, got ${String(json.action)}`,
    );
  }

  const parsed = plannerOutputSchemas[action].safeParse(json);
  if (!parsed.success) return shapeViolation(parsed.error.issues);
  const output = parsed.data;

  switch (output.action) {
    case 'clarify':
      return { ok: true, output };
    case 'decompose': {
      const bad = checkTaskGraph(
        output.tasks,
        output.tasks.map((t) => t.key),
      );
      return bad ?? { ok: true, output };
    }
    case 'grill':
    case 'write': {
      const ctx = context as PlannerParseContexts['grill' | 'write'];
      if (output.taskKey !== ctx.taskKey) {
        return violation(
          'task_mismatch',
          `expected task ${ctx.taskKey}, got ${output.taskKey}`,
        );
      }
      if (output.action === 'grill') return { ok: true, output };
      const kind = (ctx as PlannerParseContexts['write']).taskKind;
      const heading = PLANNER_REQUIRED_HEADING[kind];
      if (!hasHeading(output.document, heading)) {
        return violation(
          kind === 'feature'
            ? 'missing_acceptance_criteria'
            : 'missing_reproduction',
          `a ${kind} document needs a "## ${heading}" section`,
        );
      }
      return { ok: true, output };
    }
    case 'revise': {
      const frozen = new Set(
        (context as PlannerParseContexts['revise']).frozenKeys,
      );
      const planned = output.tasks.filter(isPlannedTask);
      const refs = output.tasks.filter((t) => !isPlannedTask(t));
      for (const task of planned) {
        if (frozen.has(task.key)) {
          return violation(
            'frozen_task',
            `task ${task.key} is approved and frozen: pass it through as { "key": "${task.key}" }`,
          );
        }
      }
      for (const ref of refs) {
        if (!frozen.has(ref.key)) {
          return violation(
            'frozen_task',
            `{ "key": "${ref.key}" } names no approved task; a new or changed task needs every field`,
          );
        }
      }
      const listed = new Set(refs.map((r) => r.key));
      const missing = [...frozen].filter((k) => !listed.has(k));
      if (missing.length > 0) {
        return violation(
          'frozen_task',
          `approved tasks must pass through: ${missing.join(', ')}`,
        );
      }
      const bad = checkTaskGraph(
        planned,
        output.tasks.map((t) => t.key),
      );
      return bad ?? { ok: true, output };
    }
  }
}

/**
 * The fixed contract text the API appends after the instructions on every
 * turn (D11, ADR-0019), and the editors show read-only.
 */
export const PLANNER_OUTPUT_CONTRACT = `# Output contract (v${PLANNER_CONTRACT_VERSION})

This contract is fixed. It overrides anything above it about the shape of
your answer.

Your final message must contain exactly one fenced block tagged
\`${PLANNER_BLOCK_TAG}\`, holding one JSON object — and no other block with
that tag. Write anything else you want to say outside it. Every object below
is closed: a key it does not name makes the whole turn fail, and nothing of it
is applied.

\`\`\`
Question = {
  "id": string,              // short, unique within the round: "q1"
  "title": string,
  "question": string,
  "options": [ { "id": string, "label": string, "detail"?: string } ],   // 0–${PLANNER_MAX_OPTIONS}
  "recommendation": { "optionId"?: string, "text": string, "why": string },
  "blocking": boolean        // true only when there is no safe default
}
Task = {
  "key": string,             // stable within the plan: "t1", "t2" … ^[a-z][a-z0-9-]{0,31}$
  "kind": "bug" | "feature",
  "title": string,
  "summary": string,
  "dependsOn": [ key ],      // keys of other tasks of this plan
  "questions": [ Question ]
}
\`\`\`

The object depends on the turn's action:

\`\`\`
clarify   → { "action": "clarify", "questions": [ Question ], "done": boolean }
decompose → { "action": "decompose", "title": string, "tasks": [ Task ] }
grill     → { "action": "grill", "taskKey": key, "questions": [ Question ], "done": boolean }
write     → { "action": "write", "taskKey": key, "document": markdown, "assumptions": [ string ] }
revise    → { "action": "revise", "tasks": [ Task | { "key": key } ] }
\`\`\`

Rules:

- \`action\` is the action the turn names.
- At most ${PLANNER_MAX_TASKS} tasks per plan, and at most ${PLANNER_MAX_QUESTIONS} questions per round.
- \`recommendation.optionId\`, when present, is the id of one of that question's options.
- Every key in \`dependsOn\` is the key of another task of the plan; no task depends on itself.
- \`grill\` and \`write\` answer about the task the turn names, and repeat its key in \`taskKey\`.
- A \`write\` document for a feature has a \`## Acceptance criteria\` section; for a bug, a \`## Reproduction\` section.
- \`revise\` lists every approved task as \`{ "key": "<key>" }\` alone, unchanged, and leaves rejected tasks out. Every other task is written in full.
- The \`document\` is a JSON string: newlines are \`\\n\`.
`;
