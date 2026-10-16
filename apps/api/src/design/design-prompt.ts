import {
  cardLabel,
  type DesignCommentKind,
  type DesignTheme,
  designBytes,
  PLANNER_BLOCK_TAG,
  plannerOutputContract,
  stackLabel,
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

/**
 * #480 (ADR-0043): the approved design of the stack a card belongs to — the
 * whole result. A card's design turn reads it as reference; the card's own
 * design stays its own.
 */
export interface StackDesignReference {
  /** `S-<number>`. */
  label: string;
  title: string;
  /** The approved revision's title and rationale. */
  revisionTitle: string;
  rationale: string;
  frames: { name: string; html: string }[];
}

/** What a board card's design turn carries besides the design (#243 D4). */
export interface CardDesignPromptInput {
  /** The project's effective planner instructions. */
  instructions: string;
  card: { number: number; title: string; body: string };
  /** The key the turn's `agentdock-plan` block repeats (`cardDesignTaskKey`). */
  taskKey: string;
  design: DesignPromptContext;
  /** #480: the card's stack's approved design; absent or null without one. */
  stackDesign?: StackDesignReference | null;
}

/** #480: a stack's design turn — the whole result, before any card of it runs. */
export interface StackDesignPromptInput {
  instructions: string;
  stack: {
    number: number;
    title: string;
    body: string;
    /** In order: each stage's name and its cards' labels and titles. */
    stages: { title: string; cards: string[] }[];
  };
  taskKey: string;
  design: DesignPromptContext;
}

/** What one design turn's prompt is built from, whoever owns the design. */
interface DesignTurnHost {
  instructions: string;
  taskKey: string;
  /** "board card C-12", "stack S-3". */
  subject: string;
  /** The owner's own section: its heading and fenced text. */
  ownSections: string[];
  design: DesignPromptContext;
}

const designTurnPromptWith = (
  host: DesignTurnHost,
  design: string[],
  reference: string[],
): string => {
  const sections = [
    host.instructions.trim(),
    plannerOutputContract(CARD_DESIGN_CONTRACT_VERSION).trim(),
    '# This turn',
    `Action: \`design\`. ${designWhat(`${host.subject} (\`${host.taskKey}\`)`, host.design)}`,
    `Answer with exactly one \`${PLANNER_BLOCK_TAG}\` block whose \`action\` is \`design\` and whose \`taskKey\` is \`${host.taskKey}\`.`,
    ...host.ownSections,
    ...reference,
    ...design,
  ];
  return `${sections.join('\n\n')}\n`;
};

/**
 * #480: the stack's approved design as a card's design turn reads it — with
 * every frame's HTML while the prompt has room, else named only.
 */
const stackReferenceSections = (
  ref: StackDesignReference,
  withHtml: boolean,
): string[] => [
  `## The stack's approved design (${ref.label}, reference)`,
  [
    `This card is part of stack ${ref.label} "${ref.title}". Its approved design, "${ref.revisionTitle}", shows the whole result. Draw this card's mockup so it fits that design: the same look, tokens and layout where they meet. Do not redraw the whole result.`,
    `Its rationale: ${ref.rationale}`,
  ].join('\n'),
  ...(withHtml
    ? ref.frames.map((f) => `### ${f.name}\n${fence('html', f.html)}`)
    : [
        `Its frames (${ref.frames.map((f) => `"${f.name}"`).join(', ')}) are too large to include here.`,
      ]),
];

/**
 * A design turn's prompt under the `plan.turn` cap: a large kit's snippets
 * are trimmed from the end first, then a reference design's HTML.
 */
const fittedDesignPrompt = (
  host: DesignTurnHost,
  reference: StackDesignReference | null,
): string => {
  const count = host.design.profile?.snippets.length ?? 0;
  const build = (keep: number, withHtml: boolean) =>
    designTurnPromptWith(
      host,
      designSections(host.design, keep),
      reference ? stackReferenceSections(reference, withHtml) : [],
    );
  let prompt = build(count, true);
  for (
    let keep = count - 1;
    keep >= 0 && designBytes(prompt) > PLAN_TURN_PROMPT_MAX_BYTES;
    keep -= 1
  ) {
    prompt = build(keep, true);
  }
  if (reference && designBytes(prompt) > PLAN_TURN_PROMPT_MAX_BYTES) {
    prompt = build(0, false);
  }
  return prompt;
};

/**
 * #243 D4: the prompt of a board card's design turn — the instructions, the
 * v2 contract, the `design` action, the card's title and body, then the
 * design sections (profile, kit, skills, variant, open comments). A large
 * kit's snippets are trimmed from the end until it fits the `plan.turn` cap,
 * as a plan task's design turn does. #480: a card of a stack whose design is
 * approved reads that design as reference.
 */
export const cardDesignPrompt = (input: CardDesignPromptInput): string => {
  const label = cardLabel(input.card.number);
  return fittedDesignPrompt(
    {
      instructions: input.instructions,
      taskKey: input.taskKey,
      subject: `board card ${label}`,
      ownSections: [
        '## The card',
        fence(
          'text',
          `${label}: ${input.card.title}\n\n${input.card.body.trim() || '(no description)'}`,
        ),
      ],
      design: input.design,
    },
    input.stackDesign ?? null,
  );
};

/**
 * #480 (ADR-0043): the prompt of a stack's design turn — one design of the
 * whole result (the full page, say) that every card of the stack builds a
 * part of. Each card may still have its own design, kept apart.
 */
export const stackDesignPrompt = (input: StackDesignPromptInput): string => {
  const label = stackLabel(input.stack.number);
  const stages = input.stack.stages
    .map(
      (stage, i) =>
        `Stage ${i + 1}${stage.title.trim() ? ` · ${stage.title.trim()}` : ''}:\n${stage.cards.map((c) => `- ${c}`).join('\n')}`,
    )
    .join('\n\n');
  return fittedDesignPrompt(
    {
      instructions: input.instructions,
      taskKey: input.taskKey,
      subject: `stack ${label}`,
      ownSections: [
        '## The stack',
        "A stack is one larger piece of work built by several cards in ordered stages. Draw the whole result — the full page or flow the stack delivers — not one card's part.",
        fence(
          'text',
          `${label}: ${input.stack.title}\n\n${input.stack.body.trim() || '(no description)'}\n\n${stages}`,
        ),
      ],
      design: input.design,
    },
    null,
  );
};
