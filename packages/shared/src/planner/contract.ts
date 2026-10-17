import type { z } from 'zod';
import { DESIGN_CDN_ALLOWLIST } from '../design/cdn';
import {
  DESIGN_FRAME_NAME_MAX,
  DESIGN_LEGACY_FRAME_NAME,
  type DesignFrameDraft,
} from '../design/frames';
import {
  DESIGN_HTML_MAX_BYTES,
  DESIGN_VARIANTS_MAX,
  designBytes,
} from '../design/limits';
import { validateMockup } from '../design/validate';
import { isReliablyEnglish } from '../text/english';
import type { PlanTurnView } from './contracts';
import {
  CARD_DRAFT_SECTIONS,
  CARD_DRAFT_TITLE_MAX,
  type CardDraft,
  INTAKE_SPLIT_MAX,
  INTAKE_SPLIT_MIN,
  INTAKE_STACK_STAGES_MIN,
  intakeCardOutputSchema,
  intakeRoundOutputSchema,
  intakeSplitOutputSchema,
  intakeStackOutputSchema,
  isIntakeCard,
  isIntakeSplit,
  isIntakeStack,
  isPlannedTask,
  PLANNER_BLOCK_TAG,
  PLANNER_CONTRACT_VERSION,
  PLANNER_DESIGN_BLOCK_TAG,
  PLANNER_INTAKE_MAX_ROUNDS,
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
  /** Design: two or more `agentdock-design` blocks and no `frames`. */
  'multiple_design_blocks',
  /**
   * Design (#441): `frames` names a different number of frames than there
   * are design blocks, or names one frame twice.
   */
  'frame_mismatch',
  /** Design: the HTML of every frame together is over `DESIGN_HTML_MAX_BYTES`. */
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
  /**
   * Intake (#337 D3, D4): a question round where the turn had to write the
   * card — after `PLANNER_INTAKE_MAX_ROUNDS` rounds, or on Enough — generate.
   */
  'must_generate',
  /** Intake (#337 D6): the card's body lacks one of `CARD_DRAFT_SECTIONS`. */
  'missing_card_section',
  /** Intake (#337 D5, ADR-0027 §6): the card's title or body is not English. */
  'not_english',
  /** Intake (#409): a split proposed after the person chose Keep one card. */
  'split_declined',
] as const;
export type PlannerViolationReason = (typeof PLANNER_VIOLATION_REASONS)[number];

export interface PlannerContractViolation {
  code: 'contract_violation';
  reason: PlannerViolationReason;
  message: string;
}

/**
 * A design turn's result also carries its frames' validated HTML (#441), in
 * order, kept out of `output`.
 */
export type PlannerParseResult<A extends PlanTurnAction> =
  | ({ ok: true; output: PlannerOutput<A> } & (A extends 'design'
      ? { frames: DesignFrameDraft[] }
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
  /** #337: what decides whether the intake turn may still ask. */
  intake: VersionContext & IntakeTurnState;
}

/**
 * #337 D3, D4: a card intake's state before a turn. `roundsAsked`: the
 * question rounds its earlier turns opened. `generate`: the person pressed
 * Enough — generate. `acceptNonEnglish`: the one re-ask of a non-English card
 * is over — the card is taken and shown with a "Not English" warning (spec
 * "Risks"). `keepOne` (#409): the person declined the split — the turn
 * writes one card, neither a round nor another split.
 */
export interface IntakeTurnState {
  roundsAsked: number;
  generate: boolean;
  acceptNonEnglish?: boolean;
  keepOne?: boolean;
}

/**
 * #337 D4: the rounds an intake asked — its succeeded `intake` turns that
 * opened one. A failed turn, or one that wrote the card, opened none.
 */
export const intakeRoundsAsked = (
  turns: readonly Pick<PlanTurnView, 'action' | 'phase' | 'rounds'>[],
): number =>
  turns.filter(
    (t) =>
      t.action === 'intake' && t.phase === 'succeeded' && t.rounds.length > 0,
  ).length;

/**
 * #337 D4: the next intake turn must write the card — no fifth round, and
 * none after Enough or after Keep one card (#409).
 */
export const intakeMustGenerate = (
  state: Pick<IntakeTurnState, 'roundsAsked' | 'generate' | 'keepOne'>,
): boolean =>
  state.generate ||
  state.keepOne === true ||
  state.roundsAsked >= PLANNER_INTAKE_MAX_ROUNDS;

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

/** #337 D6: the `CARD_DRAFT_SECTIONS` a card body lacks, in order. */
export const missingCardSections = (body: string): string[] =>
  CARD_DRAFT_SECTIONS.filter((section) => !hasHeading(body, section));

const SECTION_LINE = new RegExp(
  `^##[ \\t]+(?:${CARD_DRAFT_SECTIONS.join('|')})[ \\t]*#*[ \\t]*$`,
  'gim',
);

/**
 * #337 D5: the card's title and body pass ADR-0027 §6's English check. The
 * fixed section headings are left out of the body first: they are English in
 * any card and would carry a body in another Latin-script language over the
 * function-word share.
 */
export const isCardDraftEnglish = (draft: Pick<CardDraft, 'title' | 'body'>) =>
  isReliablyEnglish(draft.title) &&
  isReliablyEnglish(draft.body.replace(SECTION_LINE, ''));

/**
 * #337 D5, D6; #409: a written card — the single one or one of a split —
 * carries the four sections and is English. `what` names it in the message.
 */
const checkCardDraft = (
  draft: Pick<CardDraft, 'title' | 'body'>,
  ctx: PlannerParseContexts['intake'],
  what: string,
) => {
  const missing = missingCardSections(draft.body);
  if (missing.length > 0) {
    return violation(
      'missing_card_section',
      `${what}'s body needs ${missing.map((s) => `"## ${s}"`).join(', ')}`,
    );
  }
  if (ctx.acceptNonEnglish !== true && !isCardDraftEnglish(draft)) {
    return violation(
      'not_english',
      `${what}'s title and body must be written in English`,
    );
  }
  return null;
};

/** #337, #409: the intake branch an output names by its key. */
const intakeBranchSchema = (json: unknown) => {
  if (typeof json === 'object' && json !== null) {
    if ('cardDraft' in json) return intakeCardOutputSchema;
    if ('split' in json) return intakeSplitOutputSchema;
    if ('stack' in json) return intakeStackOutputSchema;
  }
  return intakeRoundOutputSchema;
};

/**
 * Spec 223 D7, #441: the design blocks, one per frame `names` lists — or the
 * one block of a turn that names no frames — each validated against D6, and
 * together at most `DESIGN_HTML_MAX_BYTES`.
 */
const parseDesignBlocks = (
  text: string,
  names: readonly string[] | undefined,
):
  | { ok: true; frames: DesignFrameDraft[] }
  | { ok: false; error: PlannerContractViolation } => {
  const blocks = extractFencedBlocks(text, PLANNER_DESIGN_BLOCK_TAG);
  if (blocks.includes(null)) {
    return violation(
      'no_design_block',
      `the ${PLANNER_DESIGN_BLOCK_TAG} block is never closed`,
    );
  }
  if (blocks.length === 0) {
    return violation('no_design_block', `no ${PLANNER_DESIGN_BLOCK_TAG} block`);
  }
  if (names === undefined && blocks.length > 1) {
    return violation(
      'multiple_design_blocks',
      `expected one ${PLANNER_DESIGN_BLOCK_TAG} block, found ${blocks.length} — name each frame in "frames"`,
    );
  }
  const frameNames = names ?? [DESIGN_LEGACY_FRAME_NAME];
  if (frameNames.length !== blocks.length) {
    return violation(
      'frame_mismatch',
      `"frames" names ${frameNames.length} frame${frameNames.length === 1 ? '' : 's'}, but there ${blocks.length === 1 ? 'is 1' : `are ${blocks.length}`} ${PLANNER_DESIGN_BLOCK_TAG} block${blocks.length === 1 ? '' : 's'}`,
    );
  }
  const seen = new Set<string>();
  for (const name of frameNames) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return violation('frame_mismatch', `"frames" names ${name} twice`);
    }
    seen.add(key);
  }
  const frames: DesignFrameDraft[] = [];
  let total = 0;
  for (const [i, html] of (blocks as string[]).entries()) {
    const name = frameNames[i];
    const check = validateMockup(html);
    if (!check.ok) {
      return violation(
        check.reason,
        blocks.length > 1 ? `frame "${name}": ${check.message}` : check.message,
      );
    }
    total += designBytes(html);
    frames.push({ name, html });
  }
  if (total > DESIGN_HTML_MAX_BYTES) {
    return violation(
      'design_too_large',
      `the frames are ${total} bytes together; at most ${DESIGN_HTML_MAX_BYTES} — draw fewer frames or move styling to an allowlisted CDN`,
    );
  }
  return { ok: true, frames };
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
  // #337: an intake names its branch by its key, so a bad card reports the
  // card's error rather than the round's "unknown key cardDraft".
  const schema =
    action === 'intake'
      ? intakeBranchSchema(json)
      : plannerOutputSchemasFor(version)[action];
  const parsed = schema.safeParse(json);
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
      const design = parseDesignBlocks(text, output.frames);
      if (!design.ok) return design;
      const parsedDesign: PlannerParseResult<'design'> = {
        ok: true,
        output,
        frames: design.frames,
      };
      return parsedDesign;
    }
    case 'intake': {
      const ctx = context as PlannerParseContexts['intake'];
      if (isIntakeStack(output)) {
        if (ctx.keepOne === true) {
          return violation(
            'split_declined',
            'the person chose to keep one card: write one card for the whole request',
          );
        }
        if (
          ctx.acceptNonEnglish !== true &&
          !isReliablyEnglish(
            [
              output.stack.title,
              output.stack.body,
              ...output.stack.stages.map((st) => st.title),
            ].join('\n'),
          )
        ) {
          return violation(
            'not_english',
            "the stack's title and body must be written in English",
          );
        }
        let n = 0;
        for (const stage of output.stack.stages) {
          for (const card of stage.cards) {
            n += 1;
            const bad = checkCardDraft(card, ctx, `stack card ${n}`);
            if (bad) return bad;
          }
        }
        return { ok: true, output };
      }
      if (isIntakeSplit(output)) {
        if (ctx.keepOne === true) {
          return violation(
            'split_declined',
            'the person chose to keep one card: write one card for the whole request',
          );
        }
        for (const [i, card] of output.split.cards.entries()) {
          const bad = checkCardDraft(card, ctx, `split card ${i + 1}`);
          if (bad) return bad;
        }
        return { ok: true, output };
      }
      if (!isIntakeCard(output)) {
        if (intakeMustGenerate(ctx)) {
          return violation(
            'must_generate',
            ctx.keepOne === true
              ? 'the person chose to keep one card: write it now'
              : ctx.generate
                ? 'the person asked to generate: write the card now'
                : `${PLANNER_INTAKE_MAX_ROUNDS} rounds were asked: write the card now`,
          );
        }
        return { ok: true, output };
      }
      return (
        checkCardDraft(output.cardDraft, ctx, 'the card') ?? {
          ok: true,
          output,
        }
      );
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

A \`design\` turn draws one variant of the task's mockup as one or more
**frames**: each frame is a named, separately rendered HTML document. Its
final message holds the usual \`${PLANNER_BLOCK_TAG}\` block **and** one fenced
block tagged \`${PLANNER_DESIGN_BLOCK_TAG}\` per frame, fenced with four
backticks, each holding one self-contained HTML document:

~~~text
\`\`\`\`${PLANNER_DESIGN_BLOCK_TAG}
<!doctype html>
<html lang="en" data-theme="light"> … </html>
\`\`\`\`
~~~

Frames:

- Draw one frame unless the task touches several pages or several standalone components. Then draw one frame per page, plus one per component that matters on its own (its states side by side).
- \`"frames"\` lists a short name per frame (at most ${DESIGN_FRAME_NAME_MAX} characters, distinct), in the order of the design blocks: \`"frames": ["Board page", "Card tile"]\`. With one frame it may be left out; the frame is then named "${DESIGN_LEGACY_FRAME_NAME}".

The mockup's rules — a frame that breaks one fails the turn:

- At most ${DESIGN_HTML_MAX_BYTES / 1024} KiB of HTML, all frames together. Inline CSS and JS are allowed.
- External scripts, styles, fonts and images only from ${CDN_HOSTS}, over HTTPS. No other host, and no relative URL: inline it or use a \`data:\` URL (images and fonts only).
- Every script or package URL names an exact version: \`react@18.3.1\`, never \`react@18\` or \`latest\`.
- No network calls (\`fetch\`, \`XMLHttpRequest\`, \`WebSocket\`, \`EventSource\`, \`sendBeacon\`), no form that submits, no navigation of the top or parent window, no \`window.open\`, no \`<iframe>\`, \`<object>\`, \`<embed>\` or \`<base>\`, no link to another site.
- The theme switches through \`:root[data-theme="light"]\` and \`:root[data-theme="dark"]\`.
- \`variant\` is the variant the turn names (1–${DESIGN_VARIANTS_MAX}); \`addressed\` lists only ids of the open comments the turn gave you.
`;

const TASK_DESIGN_LINE = `
  "design": DesignSuggestion`;

/** #337 D3, contract v3. */
const MULTIPLE_RULE =
  '- Set `"multiple": true` only when several options can hold at once. The person may always answer in their own words instead of, or beside, the options.';

/** The Question shape as the contract text of `version` writes it. */
const questionShape = (version: PlannerContractVersion): string => `Question = {
  "id": string,              // short, unique within the round: "q1"
  "title": string,
  "question": string,
  "options": [ { "id": string, "label": string, "detail"?: string } ],   // 0–${PLANNER_MAX_OPTIONS}${
    version >= 3
      ? `
  "multiple"?: boolean,      // true: the person may pick several options`
      : ''
  }
  "recommendation": { "optionId"?: string, "text": string, "why": string },
  "blocking": boolean        // true only when there is no safe default
}`;

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
${questionShape(version)}${
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
design    → { "action": "design", "taskKey": key, "variant": 1 | 2 | 3, "title": string, "rationale": string, "addressed": [ commentId ], "frames"?: [ string ] }`
      : ''
  }
\`\`\`

Rules:

- \`action\` is the action the turn names.
- At most ${PLANNER_MAX_TASKS} tasks per plan, and at most ${PLANNER_MAX_QUESTIONS} questions per round.
- \`recommendation.optionId\`, when present, is the id of one of that question's options.${
    version >= 3 ? `\n${MULTIPLE_RULE}` : ''
  }
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

/**
 * #337 D1, D4–D6: the fixed contract text of a `card` plan — a card intake.
 * The API appends it after the card-mode instructions on every intake turn,
 * in place of `plannerOutputContract`: an intake neither decomposes nor
 * writes documents. It exists from contract v3 on.
 */
export const PLANNER_INTAKE_CONTRACT = `# Output contract (v${PLANNER_CONTRACT_VERSION}, card intake)

This contract is fixed. It overrides anything above it about the shape of
your answer.

Your final message must contain exactly one fenced block tagged
\`${PLANNER_BLOCK_TAG}\`, holding one JSON object — and no other block with
that tag. Write anything else you want to say outside it. Every object below
is closed: a key it does not name makes the whole turn fail, and nothing of it
is applied.

\`\`\`
${questionShape(PLANNER_CONTRACT_VERSION)}
CardDraft = {
  "title": string,           // imperative, at most ${CARD_DRAFT_TITLE_MAX} characters
  "kind": "bug" | "feature",
  "body": markdown           // the four sections below, in this order
}
SplitCard = {
  "title": string,           // as CardDraft
  "kind": "bug" | "feature",
  "summary": string,         // one line the person reads in the proposal
  "body": markdown           // as CardDraft
}
Split = {
  "reason": string,          // why several cards, in the person's language
  "cards": [ SplitCard ]     // ${INTAKE_SPLIT_MIN}–${INTAKE_SPLIT_MAX}, independent of each other
}
StackStage = {
  "title": string,           // short English name of the stage, e.g. "Components"
  "cards": [ SplitCard ]     // may run in parallel; each waits on every card of the stage before
}
Stack = {
  "reason": string,          // why one stack in stages, in the person's language
  "title": string,           // English, the whole piece of work, at most ${CARD_DRAFT_TITLE_MAX} characters
  "body": markdown,          // English: what the whole piece of work is and when it is done
  "design": boolean,         // true when the result is UI: one shared design is drawn and approved first
  "stages": [ StackStage ]   // ${INTAKE_STACK_STAGES_MIN} or more, in order; ${INTAKE_SPLIT_MIN}–${INTAKE_SPLIT_MAX} cards in all
}
\`\`\`

Every intake turn answers with one of:

\`\`\`
intake → { "action": "intake", "questions": [ Question ] }   // a round: 1–${PLANNER_MAX_QUESTIONS} questions
intake → { "action": "intake", "cardDraft": CardDraft }      // the card
intake → { "action": "intake", "split": Split }              // a proposal of several independent cards
intake → { "action": "intake", "stack": Stack }              // a proposal of cards in ordered stages
\`\`\`

Rules:

- \`action\` is \`intake\`.
- Ask a round only while something material is unknown; write the card as soon as nothing is.
- At most ${PLANNER_INTAKE_MAX_ROUNDS} rounds. After the ${PLANNER_INTAKE_MAX_ROUNDS}th, or when the turn says the person asked to generate, write the card, the split or the stack — a round then fails the turn.
- Propose a \`split\` only when the request is several independent tasks, or one task too big for a single agent. Each card stands alone: no card depends on another. One clear task is one \`cardDraft\`.
- Propose a \`stack\` instead when the request is one larger piece of work whose parts must happen in order and share one look — for example a page redesign: its components first, then the page built from them. Group the cards into stages in that order. Set \`design\` to true when the result is UI.
- When the turn says the person chose to keep one card, write one \`cardDraft\` covering the whole request — a round, a split or a stack then fails the turn.
- Questions, options and anything you say outside the block are in the language of the person's latest text.
- Every card — \`title\`, \`summary\`, \`body\` — and a stack's \`title\`, \`body\` and stage titles are in English, whatever language the person wrote in.
- Every card's \`body\` has exactly these \`##\` sections: ${CARD_DRAFT_SECTIONS.map((s) => `\`## ${s}\``).join(', ')}. Acceptance criteria are checkable bullets; each open question names the default taken.
- \`recommendation.optionId\`, when present, is the id of one of that question's options.
${MULTIPLE_RULE}
- The \`body\` is a JSON string: newlines are \`\\n\`.
`;
