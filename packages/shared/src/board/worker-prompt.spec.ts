import { describe, expect, it } from 'bun:test';
import { DESIGN_HTML_MAX_BYTES, DESIGN_RATIONALE_MAX } from '../design';
import {
  CARD_RUN_FILE_MAX_BYTES,
  CARD_RUN_FILES_MAX,
  CARD_RUN_PROMPT_MAX_BYTES,
  cardPromptSchema,
} from '../protocol';
import { cardDesignPath } from './naming';
import { BOARD_CARD_BODY_MAX, BOARD_CARD_TITLE_MAX } from './types';
import {
  CARD_DESIGN_COMMENTS_MAX_BYTES,
  type CardWorkerPromptInput,
  cardWorkerPrompt,
} from './worker-prompt';

const bytes = (text: string): number => new TextEncoder().encode(text).length;

const path = cardDesignPath(
  'docs/specs',
  { number: 12, title: 'Add login', issueNumber: null },
  2,
);

const card: CardWorkerPromptInput = {
  number: 12,
  title: 'Add login',
  body: 'Users sign in with a password.',
  kind: 'feature',
  branch: 'card/c12-add-login',
  base: 'develop',
  specPath: 'docs/specs/card-12-add-login.md',
  issueNumber: null,
  design: {
    path,
    rationale: 'One column keeps the form readable on a phone.',
    comments: ['Make the button full width.', 'Say "Sign in",\nnot "Log in".'],
  },
};

const sectionOf = (prompt: string): string => {
  const start = prompt.indexOf('## Design');
  return prompt.slice(start, prompt.indexOf('## How to work', start));
};

describe('worker prompt — ## Design (#243 D7)', () => {
  it('has no design section without a design', () => {
    expect(cardWorkerPrompt({ ...card, design: null })).not.toContain(
      '## Design',
    );
  });

  it('names the committed mockup, what it binds, the rationale and the decisions', () => {
    const prompt = cardWorkerPrompt(card);
    const section = sectionOf(prompt);
    expect(section).toContain(
      'docs/specs/card-12-add-login/design/2.html (already committed on this branch',
    );
    expect(section).toContain('binds the layout, the states and the copy');
    expect(section).toContain('not code to copy');
    expect(section).toContain("the project's real components");
    expect(section).toContain(
      'Why this design: One column keeps the form readable on a phone.',
    );
    expect(section).toContain('- Make the button full width.');
    expect(section).toContain('- Say "Sign in", not "Log in".');
    expect(prompt.indexOf('## The card')).toBeLessThan(
      prompt.indexOf('## Design'),
    );
  });

  it('leaves out an empty rationale and an empty comment list', () => {
    const section = sectionOf(
      cardWorkerPrompt({
        ...card,
        design: { path, rationale: '  ', comments: [] },
      }),
    );
    expect(section).not.toContain('Why this design');
    expect(section).not.toContain('Decisions from the design review');
  });

  it('carries at most 4 KiB of comments, whole, and counts the rest', () => {
    const comment = 'x'.repeat(1000);
    const section = sectionOf(
      cardWorkerPrompt({
        ...card,
        design: { path, rationale: '', comments: Array(6).fill(comment) },
      }),
    );
    const shown = section.split('\n').filter((l) => l === `- ${comment}`);
    expect(shown.length).toBe(4);
    expect(4 * bytes(`- ${comment}\n`)).toBeLessThanOrEqual(
      CARD_DESIGN_COMMENTS_MAX_BYTES,
    );
    expect(section).toContain('- (2 more not shown)');
  });

  it('fits card.run at the largest card, rationale and comments, never cutting the card', () => {
    const body = '語'.repeat(BOARD_CARD_BODY_MAX);
    const prompt = cardWorkerPrompt({
      ...card,
      title: '語'.repeat(BOARD_CARD_TITLE_MAX),
      body,
      branch: `card/c999999-${'a'.repeat(40)}`,
      specPath: `${'d/'.repeat(100)}card-999999-${'a'.repeat(40)}.md`,
      design: {
        path: `${'d/'.repeat(100)}card-999999-${'a'.repeat(40)}/design/3.html`,
        rationale: '語'.repeat(DESIGN_RATIONALE_MAX),
        comments: Array(20).fill('語'.repeat(500)),
      },
    });
    expect(bytes(prompt)).toBeLessThanOrEqual(CARD_RUN_PROMPT_MAX_BYTES);
    expect(cardPromptSchema.safeParse(prompt).success).toBe(true);
    expect(prompt).toContain(body);
    expect(prompt).toContain('/design/3.html');
    expect(prompt).toContain('more not shown');
  });

  it('keeps the whole rationale when the card is short', () => {
    const rationale = '語'.repeat(DESIGN_RATIONALE_MAX);
    const prompt = cardWorkerPrompt({
      ...card,
      design: { path, rationale, comments: [] },
    });
    expect(prompt).toContain(`Why this design: ${rationale}`);
  });

  it('leaves room in card.run for the spec and the approved mockup', () => {
    expect(CARD_RUN_FILES_MAX).toBeGreaterThanOrEqual(2);
    expect(CARD_RUN_FILE_MAX_BYTES).toBeGreaterThanOrEqual(
      DESIGN_HTML_MAX_BYTES,
    );
  });
});
