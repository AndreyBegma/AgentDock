import {
  cardLabel,
  type DesignCommentKind,
  type DesignTheme,
  designBytes,
  PLANNER_BLOCK_TAG,
  plannerOutputContract,
  type UiProfileSnippet,
} from '@agentdock/shared';
import { PLAN_TURN_PROMPT_MAX_BYTES } from '@agentdock/shared/protocol';

/**
 * The design sections of a plan turn's prompt (docs/specs/223-design-stage.md
 * D8, D15, D16). Pure: the planner's `assemblePrompt` renders them, the
 * design flow loads what they need.
 */

/** A comment as a design turn reads it: its anchor, and the revision it was left on. */
export interface DesignPromptComment {
  id: string;
  kind: DesignCommentKind;
  variant: number;
  revision: number;
  /** #441: the name of the frame it was left on. */
  frame: string;
  viewport: string | null;
  theme: DesignTheme | null;
  x: number | null;
  y: number | null;
  selector: string | null;
  body: string;
}

/** The profile version a design turn draws from (D12). */
export interface DesignPromptProfile {
  version: number;
  hasUi: boolean;
  summary: string;
  kit: string;
  snippets: UiProfileSnippet[];
}

/** What a `design` turn carries besides the plan (D8). */
export interface DesignPromptContext {
  variant: number;
  variantCount: number;
  /** `generate` draws a variant's first revision; `revise` its next (D10). */
  mode: 'generate' | 'revise';
  /** The variant's latest revision, on a revise, with its frames' names (#441). */
  previous: {
    revision: number;
    title: string;
    rationale: string;
    frames: string[];
  } | null;
  profile: DesignPromptProfile | null;
  /** The design skills to apply, installed ones only (D15). */
  skills: string[];
  /** Every open comment of the design, oldest first (D10). */
  comments: DesignPromptComment[];
}

/** The approved design a `write` turn records under `## Design` (D16). */
export interface ApprovedDesignContext {
  /**
   * #441: the folder the frames are published in, and each frame's file;
   * `<issue>` stands for the issue number.
   */
  dir: string;
  frames: { name: string; path: string }[];
  variant: number;
  title: string;
  rationale: string;
  /** The comments the design took, as decisions, with their frame's name. */
  decisions: {
    kind: DesignCommentKind;
    frame: string;
    anchor: string | null;
    body: string;
  }[];
}

const fence = (lang: string, body: string): string => {
  // A fence longer than any backtick run inside, so the body cannot close it.
  const longest = Math.max(
    2,
    ...[...body.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${body}\n${ticks}`;
};

/** A comment's anchor in words: `Mobile, dark, at (12, 340) on main > button`. */
export const anchorOf = (c: {
  viewport: string | null;
  theme: DesignTheme | null;
  x: number | null;
  y: number | null;
  selector: string | null;
}): string | null => {
  const parts = [
    c.viewport,
    c.theme,
    c.x !== null && c.y !== null
      ? `at (${Math.round(c.x)}, ${Math.round(c.y)})`
      : null,
    c.selector ? `on \`${c.selector}\`` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(', ') : null;
};

const commentsJson = (comments: readonly DesignPromptComment[]): string =>
  JSON.stringify(
    comments.map((c) => ({
      id: c.id,
      kind: c.kind,
      leftOn: { variant: c.variant, revision: c.revision, frame: c.frame },
      ...(c.viewport !== null ? { viewport: c.viewport } : {}),
      ...(c.theme !== null ? { theme: c.theme } : {}),
      ...(c.x !== null && c.y !== null ? { point: { x: c.x, y: c.y } } : {}),
      ...(c.selector !== null ? { selector: c.selector } : {}),
      body: c.body,
    })),
    null,
    2,
  );

/**
 * The one-line instruction of a design turn. `subject` names the owner:
 * ``task `t1` `` for a plan task, the card for a board card (#243).
 */
export const designWhat = (
  subject: string,
  ctx: DesignPromptContext,
): string =>
  ctx.mode === 'generate'
    ? `Draw variant ${ctx.variant} of ${ctx.variantCount} of the mockup of ${subject}.`
    : `Revise variant ${ctx.variant} of the mockup of ${subject}: draw its revision ${(ctx.previous?.revision ?? 0) + 1}, answering the open comments.`;

/**
 * The design turn's sections. `snippetLimit` caps how many of the profile's
 * snippets are included, so a large kit can still fit the prompt cap; the
 * section says when some were left out.
 */
export const designSections = (
  ctx: DesignPromptContext,
  snippetLimit = Number.POSITIVE_INFINITY,
): string[] => {
  const sections = [
    '## Design',
    [
      `Variant: ${ctx.variant} (of ${ctx.variantCount}).`,
      ctx.previous
        ? `Your latest revision of this variant is revision ${ctx.previous.revision}: "${ctx.previous.title}". Its rationale: ${ctx.previous.rationale}`
        : null,
      ctx.previous
        ? `Its frames, in order: ${ctx.previous.frames.map((f) => `"${f}"`).join(', ')}. Draw the whole revision again: keep the frames the comments leave alone, and change, add or drop frames as they ask. A comment names the frame it was left on in \`leftOn.frame\`.`
        : null,
      'Use one frame unless the task touches several pages or several standalone components; then draw one frame per page, plus one per component that matters on its own.',
      `Answer with the \`agentdock-plan\` block — \`"variant": ${ctx.variant}\`, and \`"frames"\` naming each frame in order — and one \`agentdock-design\` block per frame, each fenced with four backticks.`,
    ]
      .filter((l): l is string => l !== null)
      .join('\n'),
  ];
  const profile = ctx.profile;
  if (!profile) {
    sections.push(
      '## UI profile',
      'The project has no UI profile. Draw the mockup in a neutral style.',
    );
  } else {
    const snippets = profile.snippets.slice(0, snippetLimit);
    const left = profile.snippets.length - snippets.length;
    sections.push(
      `## UI profile (version ${profile.version})`,
      fence('markdown', profile.summary),
      '### Style kit',
      'Include it in a `<style>` and build from its custom properties.',
      fence('css', profile.kit),
      '### Component snippets',
      snippets.length > 0
        ? snippets
            .map((s) => `${s.name}:\n${fence('html', s.html)}`)
            .join('\n\n')
        : 'None.',
    );
    if (left > 0) {
      sections.push(
        `${left} more snippet${left === 1 ? ' was' : 's were'} left out to keep the prompt under its size limit: ${profile.snippets
          .slice(snippets.length)
          .map((s) => `\`${s.name}\``)
          .join(', ')}. Draw those components from the kit's tokens.`,
      );
    }
  }
  sections.push(
    '## Design skills',
    ctx.skills.length > 0
      ? `Apply these installed skills: ${ctx.skills.map((s) => `\`${s}\``).join(', ')}.`
      : 'None.',
  );
  if (ctx.comments.length > 0) {
    sections.push(
      '## Open comments',
      'List in `addressed` the ids of the comments this revision answers. A pin names the element by its CSS path and its point in document coordinates.',
      fence('json', commentsJson(ctx.comments)),
    );
  }
  return sections;
};

/** The write turn's section for a task with an approved design (D16). */
export const approvedDesignSections = (d: ApprovedDesignContext): string[] => [
  '## Approved design',
  [
    d.frames.length === 1
      ? `The approved mockup is variant ${d.variant}: "${d.title}". It is published at \`${d.frames[0].path}\` — write that path, with \`<issue>\` as it is, in the document's \`## Design\` section; AgentDock fills in the issue number.`
      : `The approved design is variant ${d.variant}: "${d.title}", in ${d.frames.length} frames published under \`${d.dir}/\` — list every one of these paths, with \`<issue>\` as it is, in the document's \`## Design\` section; AgentDock fills in the issue number:\n${d.frames.map((f) => `- \`${f.path}\` — ${f.name}`).join('\n')}`,
    `Its rationale: ${d.rationale}`,
  ].join('\n'),
  d.decisions.length > 0
    ? `Decisions taken in the design's comments:\n${fence(
        'text',
        d.decisions
          .map(
            (c) =>
              `- ${c.kind}${d.frames.length > 1 ? ` on "${c.frame}"` : ''}${c.anchor ? ` (${c.anchor})` : ''}: ${c.body.replace(/\s+/g, ' ')}`,
          )
          .join('\n'),
      )}`
    : 'No comments were left on it.',
];

/** #243 D4: a card's design turns always answer contract version 2. */
export const CARD_DESIGN_CONTRACT_VERSION = 2;

/** What a board card's design turn carries besides the design (#243 D4). */
export interface CardDesignPromptInput {
  /** The project's effective planner instructions. */
  instructions: string;
  card: { number: number; title: string; body: string };
  /** The key the turn's `agentdock-plan` block repeats (`cardDesignTaskKey`). */
  taskKey: string;
  design: DesignPromptContext;
}

const cardDesignPromptWith = (
  input: CardDesignPromptInput,
  design: string[],
): string => {
  const label = cardLabel(input.card.number);
  const sections = [
    input.instructions.trim(),
    plannerOutputContract(CARD_DESIGN_CONTRACT_VERSION).trim(),
    '# This turn',
    `Action: \`design\`. ${designWhat(`board card ${label} (\`${input.taskKey}\`)`, input.design)}`,
    `Answer with exactly one \`${PLANNER_BLOCK_TAG}\` block whose \`action\` is \`design\` and whose \`taskKey\` is \`${input.taskKey}\`.`,
    '## The card',
    fence(
      'text',
      `${label}: ${input.card.title}\n\n${input.card.body.trim() || '(no description)'}`,
    ),
    ...design,
  ];
  return `${sections.join('\n\n')}\n`;
};

/**
 * #243 D4: the prompt of a board card's design turn — the instructions, the
 * v2 contract, the `design` action, the card's title and body, then the
 * design sections (profile, kit, skills, variant, open comments). A large
 * kit's snippets are trimmed from the end until it fits the `plan.turn` cap,
 * as a plan task's design turn does.
 */
export const cardDesignPrompt = (input: CardDesignPromptInput): string => {
  const count = input.design.profile?.snippets.length ?? 0;
  let prompt = cardDesignPromptWith(input, designSections(input.design));
  for (
    let keep = count - 1;
    keep >= 0 && designBytes(prompt) > PLAN_TURN_PROMPT_MAX_BYTES;
    keep -= 1
  ) {
    prompt = cardDesignPromptWith(input, designSections(input.design, keep));
  }
  return prompt;
};
