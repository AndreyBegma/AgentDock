import type { z } from 'zod';
import { DESIGN_CDN_ALLOWLIST } from '../design/cdn';
import { DESIGN_HTML_MAX_BYTES, DESIGN_VARIANTS_MAX } from '../design/limits';
import { validateMockup } from '../design/validate';
import {
  isPlannedTask,
  PLANNER_BLOCK_TAG,
  PLANNER_CONTRACT_VERSION,
  PLANNER_DESIGN_BLOCK_TAG,
  PLANNER_MAX_OPTIONS,
  PLANNER_MAX_QUESTIONS,
  PLANNER_MAX_TASKS,
  type PlannedTask,
  type PlannerContractVersion,
  type PlannerOutput,
  type PlanTaskKind,
  type PlanTurnAction,
  plannerOutputSchemasFor,
} from './types';

/**
 * The output contract, v1 and v2 (docs/specs/172-planner.md "Output
 * contract", D17; docs/specs/223-design-stage.md "Output contract (v2)").
 * The API extracts the one `agentdock-plan` block of a turn's final message
 * — and, for a design turn, the one `agentdock-design` block — and validates
 * them here against the plan's contract version. A turn that fails is
 * `contract_violation` and applies nothing, so `reason` exists to say why —
 * not to recover.
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
  /** Design: no `agentdock-design` block, or one that is never closed. */
  'no_design_block',
  /** Design: two or more `agentdock-design` blocks. */
  'multiple_design_blocks',
  /** Design: the HTML is over `DESIGN_HTML_MAX_BYTES`. */
  'design_too_large',
  /** Design: a resource from a host that is not on the CDN allowlist. */
  'design_host_not_allowed',
  /** Design: a CDN package URL without an exact version. */
  'design_unpinned_version',
  /** Design: network calls, a form submit, top navigation. */
  'design_forbidden_feature',
  /** Design: `variant` is not the variant the turn was asked for. */
  'variant_mismatch',
  /** Design: `addressed` names a comment that is not open on the design. */
  'unknown_comment',
] as const;
export type PlannerViolationReason = (typeof PLANNER_VIOLATION_REASONS)[number];

export interface PlannerContractViolation {
  code: 'contract_violation';
  reason: PlannerViolationReason;
  message: string;
}

/** A design turn's result also carries the validated HTML, kept out of `output`. */
export type PlannerParseResult<A extends PlanTurnAction> =
  | ({ ok: true; output: PlannerOutput<A> } & (A extends 'design'
      ? { html: string }
      : unknown))
  | { ok: false; error: PlannerContractViolation };

/**
 * Every context: the plan's contract version — its turns are validated
 * against the version it was created with. Default: the current version.
 */
interface VersionContext {
  contractVersion?: PlannerContractVersion;
}

/** What the API knows about the turn that the output alone cannot say. */
export interface PlannerParseContexts {
  clarify: VersionContext;
  decompose: VersionContext;
  /** The task the grill turn was about. */
  grill: VersionContext & { taskKey: string };
  /** The task, and its kind: it decides which heading the document needs. */
  write: VersionContext & { taskKey: string; taskKind: PlanTaskKind };
  /** The keys of the approved tasks, which must pass through unchanged (D9). */
  revise: VersionContext & { frozenKeys: readonly string[] };
  /**
   * The task, the variant the turn draws, and the ids of the design's open
   * comments — the only ones `addressed` may name (spec 223 D10).
   */
  design: VersionContext & {
    taskKey: string;
    variant: number;
    openCommentIds: readonly string[];
  };
}

type ContextArgs<A extends PlanTurnAction> =
  // biome-ignore lint/complexity/noBannedTypes: an empty context is optional
  {} extends PlannerParseContexts[A]
    ? [context?: PlannerParseContexts[A]]
    : [context: PlannerParseContexts[A]];

const violation = (
  reason: PlannerViolationReason,
  message: string,
): { ok: false; error: PlannerContractViolation } => ({
  ok: false,
  error: { code: 'contract_violation', reason, message },
});

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The contents of every fenced block tagged `tag` (CommonMark fences: ``` or
 * ~~~, closed by a fence of the same character at least as long). Other
 * fenced blocks are skipped whole, so a tag quoted inside one is not a block
 * — which is why a design block, whose HTML may hold a ``` line, is fenced
 * with four backticks. `null` marks a tagged block that is never closed.
 */
export const extractFencedBlocks = (
  text: string,
  tag: string,
): (string | null)[] => {
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
    if (info === tag) blocks.push(closed ? body.join('\n') : null);
  }
  return blocks;
};

/** Every `agentdock-plan` block of a turn's final message. */
export const extractPlannerBlocks = (text: string): (string | null)[] =>
  extractFencedBlocks(text, PLANNER_BLOCK_TAG);

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

/** Spec 223 D7: the one design block, its HTML validated against D6. */
const parseDesignBlock = (
  text: string,
):
  | { ok: true; html: string }
  | { ok: false; error: PlannerContractViolation } => {
  const blocks = extractFencedBlocks(text, PLANNER_DESIGN_BLOCK_TAG);
  if (blocks.length > 1) {
    return violation(
      'multiple_design_blocks',
      `expected one ${PLANNER_DESIGN_BLOCK_TAG} block, found ${blocks.length}`,
    );
  }
  const html = blocks[0];
  if (html === undefined || html === null) {
    return violation(
      'no_design_block',
      html === null
        ? `the ${PLANNER_DESIGN_BLOCK_TAG} block is never closed`
        : `no ${PLANNER_DESIGN_BLOCK_TAG} block`,
    );
  }
  const check = validateMockup(html);
  if (!check.ok) return violation(check.reason, check.message);
  return { ok: true, html };
};

/**
 * Validates a turn's final message against the contract for `action`, in the
 * plan's contract version. `grill`, `write`, `revise` and `design` take the
 * context only the API knows.
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

  const version = context?.contractVersion ?? PLANNER_CONTRACT_VERSION;
  const parsed = plannerOutputSchemasFor(version)[action].safeParse(json);
  if (!parsed.success) return shapeViolation(parsed.error.issues);
  const output: PlannerOutput = parsed.data;

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
    case 'design': {
      const ctx = context as PlannerParseContexts['design'];
      if (output.taskKey !== ctx.taskKey) {
        return violation(
          'task_mismatch',
          `expected task ${ctx.taskKey}, got ${output.taskKey}`,
        );
      }
      if (output.variant !== ctx.variant) {
        return violation(
          'variant_mismatch',
          `expected variant ${ctx.variant}, got ${output.variant}`,
        );
      }
      const open = new Set(ctx.openCommentIds);
      const unknown = output.addressed.find((id) => !open.has(id));
      if (unknown !== undefined) {
        return violation(
          'unknown_comment',
          `addressed names ${unknown}, which is not an open comment of this design`,
        );
      }
      const design = parseDesignBlock(text);
      if (!design.ok) return design;
      const parsedDesign: PlannerParseResult<'design'> = {
        ok: true,
        output,
        html: design.html,
      };
      return parsedDesign;
    }
  }
}

const CDN_HOSTS = DESIGN_CDN_ALLOWLIST.map(
  (s) => `\`${s.host}${s.pathPrefix === '/' ? '' : s.pathPrefix}\``,
).join(', ');

/**
 * Spec 223 D6, D7: the design action's rules. Part of the v2 text; the API
 * appends it alone to a design turn of a v1 plan, whose contract text does
 * not carry it (a v1 plan's design is switched on by hand).
 */
export const PLANNER_DESIGN_CONTRACT = `## The design action

A \`design\` turn draws one variant of the task's mockup. Its final message
holds the usual \`${PLANNER_BLOCK_TAG}\` block **and** exactly one fenced block
tagged \`${PLANNER_DESIGN_BLOCK_TAG}\`, fenced with four backticks, holding
one self-contained HTML document:

~~~text
\`\`\`\`${PLANNER_DESIGN_BLOCK_TAG}
<!doctype html>
<html lang="en" data-theme="light"> … </html>
\`\`\`\`
~~~

The mockup's rules — a mockup that breaks one fails the turn:

- At most ${DESIGN_HTML_MAX_BYTES / 1024} KiB of HTML. Inline CSS and JS are allowed.
- External scripts, styles, fonts and images only from ${CDN_HOSTS}, over HTTPS. No other host, and no relative URL: inline it or use a \`data:\` URL (images and fonts only).
- Every script or package URL names an exact version: \`react@18.3.1\`, never \`react@18\` or \`latest\`.
- No network calls (\`fetch\`, \`XMLHttpRequest\`, \`WebSocket\`, \`EventSource\`, \`sendBeacon\`), no form that submits, no navigation of the top or parent window, no \`window.open\`, no \`<iframe>\`, \`<object>\`, \`<embed>\` or \`<base>\`, no link to another site.
- The theme switches through \`:root[data-theme="light"]\` and \`:root[data-theme="dark"]\`.
- \`variant\` is the variant the turn names (1–${DESIGN_VARIANTS_MAX}); \`addressed\` lists only ids of the open comments the turn gave you.
`;

const TASK_DESIGN_LINE = `
  "design": DesignSuggestion`;

/**
 * The fixed contract text of `version` the API appends after the
 * instructions on every turn of a plan of that version (D11, ADR-0019), and
 * the editors show read-only.
 */
export const plannerOutputContract = (
  version: PlannerContractVersion,
): string => {
  const v2 = version >= 2;
  return `# Output contract (v${version})

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
}${
    v2
      ? `
DesignSuggestion = {
  "needed": boolean,         // does this task need a mockup before it is written?
  "why": string,             // one line
  "variants": 1 | 2 | 3      // 1 for an unambiguous change; 2–3 for real layout choices
}`
      : ''
  }
Task = {
  "key": string,             // stable within the plan: "t1", "t2" … ^[a-z][a-z0-9-]{0,31}$
  "kind": "bug" | "feature",
  "title": string,
  "summary": string,
  "dependsOn": [ key ],      // keys of other tasks of this plan
  "questions": [ Question ]${v2 ? `,${TASK_DESIGN_LINE}` : ''}
}
\`\`\`

The object depends on the turn's action:

\`\`\`
clarify   → { "action": "clarify", "questions": [ Question ], "done": boolean }
decompose → { "action": "decompose", "title": string, "tasks": [ Task ] }
grill     → { "action": "grill", "taskKey": key, "questions": [ Question ], "done": boolean${v2 ? ', "design"?: DesignSuggestion' : ''} }
write     → { "action": "write", "taskKey": key, "document": markdown, "assumptions": [ string ] }
revise    → { "action": "revise", "tasks": [ Task | { "key": key } ] }${
    v2
      ? `
design    → { "action": "design", "taskKey": key, "variant": 1 | 2 | 3, "title": string, "rationale": string, "addressed": [ commentId ] }`
      : ''
  }
\`\`\`

Rules:

- \`action\` is the action the turn names.
- At most ${PLANNER_MAX_TASKS} tasks per plan, and at most ${PLANNER_MAX_QUESTIONS} questions per round.
- \`recommendation.optionId\`, when present, is the id of one of that question's options.
- Every key in \`dependsOn\` is the key of another task of the plan; no task depends on itself.
- \`grill\` and \`write\` answer about the task the turn names, and repeat its key in \`taskKey\`.
- A \`write\` document for a feature has a \`## Acceptance criteria\` section; for a bug, a \`## Reproduction\` section.
- \`revise\` lists every approved task as \`{ "key": "<key>" }\` alone, unchanged, and leaves rejected tasks out. Every other task is written in full.
- The \`document\` is a JSON string: newlines are \`\\n\`.${
    v2
      ? `
- Every task written in full carries \`design\`. A \`grill\` repeats it only when the conversation changed it.

${PLANNER_DESIGN_CONTRACT}`
      : '\n'
  }`;
};

/** The current version's contract text — the one new plans run with. */
export const PLANNER_OUTPUT_CONTRACT = plannerOutputContract(
  PLANNER_CONTRACT_VERSION,
);
