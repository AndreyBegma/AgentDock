import {
  type DesignCommentKind,
  type DesignTheme,
  type UiProfileSnippet,
} from '@agentdock/shared';

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
  /** The variant's latest revision, on a revise. */
  previous: { revision: number; title: string; rationale: string } | null;
  profile: DesignPromptProfile | null;
  /** The design skills to apply, installed ones only (D15). */
  skills: string[];
  /** Every open comment of the design, oldest first (D10). */
  comments: DesignPromptComment[];
}

/** The approved design a `write` turn records under `## Design` (D16). */
export interface ApprovedDesignContext {
  /** The file the design is published at; `<issue>` stands for the issue number. */
  path: string;
  variant: number;
  title: string;
  rationale: string;
  /** The comments the design took, as decisions. */
  decisions: { kind: DesignCommentKind; anchor: string | null; body: string }[];
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
      leftOn: { variant: c.variant, revision: c.revision },
      ...(c.viewport !== null ? { viewport: c.viewport } : {}),
      ...(c.theme !== null ? { theme: c.theme } : {}),
      ...(c.x !== null && c.y !== null ? { point: { x: c.x, y: c.y } } : {}),
      ...(c.selector !== null ? { selector: c.selector } : {}),
      body: c.body,
    })),
    null,
    2,
  );

/** The one-line instruction of a design turn. */
export const designWhat = (
  taskKey: string,
  ctx: DesignPromptContext,
): string =>
  ctx.mode === 'generate'
    ? `Draw variant ${ctx.variant} of ${ctx.variantCount} of the mockup of task \`${taskKey}\`.`
    : `Revise variant ${ctx.variant} of the mockup of task \`${taskKey}\`: draw its revision ${(ctx.previous?.revision ?? 0) + 1}, answering the open comments.`;

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
      `Answer with the \`agentdock-plan\` block — \`"variant": ${ctx.variant}\` — and one \`agentdock-design\` block fenced with four backticks.`,
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
    `The approved mockup is variant ${d.variant}: "${d.title}". It is published at \`${d.path}\` — write that path, with \`<issue>\` as it is, in the document's \`## Design\` section; AgentDock fills in the issue number.`,
    `Its rationale: ${d.rationale}`,
  ].join('\n'),
  d.decisions.length > 0
    ? `Decisions taken in the design's comments:\n${fence(
        'text',
        d.decisions
          .map(
            (c) =>
              `- ${c.kind}${c.anchor ? ` (${c.anchor})` : ''}: ${c.body.replace(/\s+/g, ' ')}`,
          )
          .join('\n'),
      )}`
    : 'No comments were left on it.',
];
