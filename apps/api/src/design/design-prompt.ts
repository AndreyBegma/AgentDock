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
  /**
   * The variant's latest revision, on a revise, with its frames (#441). #628:
   * the prompt carries the frames the comments point at in full and a
   * summary of the rest; the turn keeps what it does not change.
   */
  previous: {
    revision: number;
    title: string;
    rationale: string;
    frames: { name: string; html: string }[];
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

/** Headings a frame summary lists, and the characters each keeps. */
const SUMMARY_HEADINGS_MAX = 8;
const SUMMARY_TEXT_MAX = 60;

const plainText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

const clip = (text: string): string =>
  text.length > SUMMARY_TEXT_MAX
    ? `${text.slice(0, SUMMARY_TEXT_MAX - 1)}…`
    : text;

/**
 * #628: one line that stands in for a frame a revision does not send in
 * full — its size, its `<title>` and its first headings.
 */
export const frameSummary = (frame: { name: string; html: string }): string => {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(frame.html);
  const headings = [
    ...frame.html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi),
  ]
    .map((m) => clip(plainText(m[1] ?? '')))
    .filter((h) => h.length > 0)
    .slice(0, SUMMARY_HEADINGS_MAX);
  const parts = [
    `${Math.max(1, Math.round(designBytes(frame.html) / 1024))} KiB`,
    title && plainText(title[1] ?? '')
      ? `titled "${clip(plainText(title[1] ?? ''))}"`
      : null,
    headings.length > 0
      ? `headings: ${headings.map((h) => `"${h}"`).join(', ')}`
      : null,
  ].filter((p): p is string => p !== null);
  return `- "${frame.name}" — ${parts.join('; ')}`;
};

/**
 * #628: the names of the previous revision's frames a revise sends in full —
 * those an open comment left on this variant points at. With none, every
 * frame: the turn has nothing to narrow it down.
 */
export const framesInFull = (ctx: DesignPromptContext): Set<string> => {
  const frames = ctx.previous?.frames ?? [];
  const names = new Set(frames.map((f) => f.name.toLowerCase()));
  const pointed = new Set(
    ctx.comments
      .filter((c) => c.variant === ctx.variant)
      .map((c) => c.frame.toLowerCase())
      .filter((name) => names.has(name)),
  );
  return pointed.size > 0 ? pointed : names;
};

/**
 * #628: the parts of a design turn that stay the same from turn to turn of
 * one design — the UI profile and the skills. They come before the turn's
 * own sections, so the prompt's changing part is its tail. `snippetLimit`
 * caps how many of the profile's snippets are included, so a large kit can
 * still fit the prompt cap; the section says when some were left out.
 */
export const designProfileSections = (
  ctx: DesignPromptContext,
  snippetLimit = Number.POSITIVE_INFINITY,
): string[] => {
  const sections: string[] = [];
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
  return sections;
};

/** #628: a revise's previous revision — the frames in play in full, the rest summarized. */
const previousSections = (
  ctx: DesignPromptContext,
  withHtml: boolean,
): string[] => {
  const previous = ctx.previous;
  if (!previous) return [];
  const full = withHtml ? framesInFull(ctx) : new Set<string>();
  const sent = previous.frames.filter((f) => full.has(f.name.toLowerCase()));
  const summarized = previous.frames.filter(
    (f) => !full.has(f.name.toLowerCase()),
  );
  return [
    `### Revision ${previous.revision}`,
    ...sent.map((f) => `#### Frame "${f.name}"\n${fence('html', f.html)}`),
    ...(summarized.length > 0
      ? [
          sent.length > 0
            ? 'The other frames, summarized:'
            : 'Its frames, summarized (too large to include here):',
          summarized.map(frameSummary).join('\n'),
        ]
      : []),
  ];
};

/**
 * The turn's own sections: the variant, on a revise the previous revision
 * (#628: only the frames the comments point at in full), and the open
 * comments. `withHtml` false summarizes every previous frame, the last resort
 * of a prompt over its cap.
 */
export const designTurnSections = (
  ctx: DesignPromptContext,
  withHtml = true,
): string[] => {
  const previous = ctx.previous;
  const sections = [
    '## Design',
    [
      `Variant: ${ctx.variant} (of ${ctx.variantCount}).`,
      previous
        ? `Your latest revision of this variant is revision ${previous.revision}: "${previous.title}". Its rationale: ${previous.rationale}`
        : null,
      previous
        ? `Its frames, in order: ${previous.frames.map((f) => `"${f.name}"`).join(', ')}. Change, add or drop frames as the comments ask. A comment names the frame it was left on in \`leftOn.frame\`. Keep every frame the comments leave alone: name it in \`"kept"\` and give it no design block — Nautelle copies it from revision ${previous.revision} as it is.`
        : null,
      'Use one frame unless the task touches several pages or several standalone components; then draw one frame per page, plus one per component that matters on its own.',
      previous
        ? `Answer with the \`agentdock-plan\` block — \`"variant": ${ctx.variant}\`, \`"frames"\` naming each frame of the revision in order, kept ones included, and \`"kept"\` naming the kept ones — and one \`agentdock-design\` block per frame you draw, in order, each fenced with four backticks.`
        : `Answer with the \`agentdock-plan\` block — \`"variant": ${ctx.variant}\`, and \`"frames"\` naming each frame in order — and one \`agentdock-design\` block per frame, each fenced with four backticks.`,
    ]
      .filter((l): l is string => l !== null)
      .join('\n'),
    ...previousSections(ctx, withHtml),
  ];
  if (ctx.comments.length > 0) {
    sections.push(
      '## Open comments',
      'List in `addressed` the ids of the comments this revision answers. A pin names the element by its CSS path and its point in document coordinates.',
      fence('json', commentsJson(ctx.comments)),
    );
  }
  return sections;
};

/**
 * The design turn's sections: the stable profile and skills first, then the
 * turn's own (#628).
 */
export const designSections = (
  ctx: DesignPromptContext,
  snippetLimit = Number.POSITIVE_INFINITY,
  withHtml = true,
): string[] => [
  ...designProfileSections(ctx, snippetLimit),
  ...designTurnSections(ctx, withHtml),
];

/** The write turn's section for a task with an approved design (D16). */
export const approvedDesignSections = (d: ApprovedDesignContext): string[] => [
  '## Approved design',
  [
    d.frames.length === 1
      ? `The approved mockup is variant ${d.variant}: "${d.title}". It is published at \`${d.frames[0].path}\` — write that path, with \`<issue>\` as it is, in the document's \`## Design\` section; Nautelle fills in the issue number.`
      : `The approved design is variant ${d.variant}: "${d.title}", in ${d.frames.length} frames published under \`${d.dir}/\` — list every one of these paths, with \`<issue>\` as it is, in the document's \`## Design\` section; Nautelle fills in the issue number:\n${d.frames.map((f) => `- \`${f.path}\` — ${f.name}`).join('\n')}`,
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
 * #480 (ADR-0044): the approved design of the stack a card belongs to — the
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

/**
 * #628: what stays the same across the turns of one design comes first —
 * the instructions, the contract, the owner, the reference design, the
 * profile and the skills — and the turn's own action, variant, previous
 * revision and comments last.
 */
const designTurnPromptWith = (
  host: DesignTurnHost,
  profile: string[],
  turn: string[],
  reference: string[],
): string => {
  const sections = [
    host.instructions.trim(),
    plannerOutputContract(CARD_DESIGN_CONTRACT_VERSION).trim(),
    ...host.ownSections,
    ...reference,
    ...profile,
    '# This turn',
    `Action: \`design\`. ${designWhat(`${host.subject} (\`${host.taskKey}\`)`, host.design)}`,
    `Answer with exactly one \`${PLANNER_BLOCK_TAG}\` block whose \`action\` is \`design\` and whose \`taskKey\` is \`${host.taskKey}\`.`,
    ...turn,
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
 * are trimmed from the end first, then a reference design's HTML, then
 * (#628) the previous revision's HTML.
 */
const fittedDesignPrompt = (
  host: DesignTurnHost,
  reference: StackDesignReference | null,
): string => {
  const count = host.design.profile?.snippets.length ?? 0;
  const build = (keep: number, withReference: boolean, withFrames = true) =>
    designTurnPromptWith(
      host,
      designProfileSections(host.design, keep),
      designTurnSections(host.design, withFrames),
      reference ? stackReferenceSections(reference, withReference) : [],
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
  if (designBytes(prompt) > PLAN_TURN_PROMPT_MAX_BYTES) {
    prompt = build(0, false, false);
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
 * #480 (ADR-0044): the prompt of a stack's design turn — one design of the
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
