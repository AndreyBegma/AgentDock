import { describe, expect, it } from 'bun:test';
import { DESIGN_HTML_MAX_BYTES, DESIGN_RATIONALE_MAX } from '../design';
import {
  CARD_RUN_FILE_MAX_BYTES,
  CARD_RUN_FILES_MAX,
  CARD_RUN_PROMPT_MAX_BYTES,
  cardPromptSchema,
} from '../protocol';
import { cardDesignPath } from './naming';
import {
  BOARD_CARD_BODY_MAX,
  BOARD_CARD_TITLE_MAX,
  CARD_FEEDBACK_MAX,
} from './types';
import {
  CARD_BODY_CUT_SUFFIX,
  CARD_CONTINUE_PROMPT,
  CARD_DESIGN_COMMENTS_MAX_BYTES,
  CARD_WORKER_PROMPT_VERSION,
  type CardText,
  type CardWorkerPromptInput,
  cardChange,
  cardFeedbackPrompt,
  cardNextRoundPrompt,
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

describe('next round prompt — card edits reach the worker (#273 D1–D4)', () => {
  const before: CardText = {
    title: 'Add login',
    body: 'Users sign in with a password.',
    kind: 'feature',
  };

  it('is version 3', () => {
    expect(CARD_WORKER_PROMPT_VERSION).toBe(3);
  });

  it('cardChange is null for identical text, whitespace around it aside', () => {
    expect(cardChange(before, { ...before })).toBeNull();
    expect(
      cardChange(before, { ...before, body: `  ${before.body}\n` }),
    ).toBeNull();
  });

  it('cardChange lists exactly the changed fields', () => {
    expect(cardChange(before, { ...before, title: 'Add SSO' })?.fields).toEqual(
      ['title'],
    );
    expect(cardChange(before, { ...before, body: 'Use SSO.' })?.fields).toEqual(
      ['body'],
    );
    expect(
      cardChange(before, { title: 'Fix login', body: 'Broken.', kind: 'bug' })
        ?.fields,
    ).toEqual(['title', 'kind', 'body']);
  });

  it('is `continue` with no change and no feedback', () => {
    expect(
      cardNextRoundPrompt({ label: 'C-12', change: null, feedback: null }),
    ).toBe(CARD_CONTINUE_PROMPT);
    expect(CARD_CONTINUE_PROMPT).toBe('continue');
  });

  it("with feedback only, is today's feedback prompt", () => {
    expect(
      cardNextRoundPrompt({
        label: 'C-12',
        change: null,
        feedback: ' Rename the button. ',
      }),
    ).toBe(cardFeedbackPrompt(' Rename the button. '));
    expect(cardFeedbackPrompt('Rename the button.')).toBe(
      'Review feedback: Rename the button.\n\nAddress it on the same branch, commit, then call finish_card.',
    );
  });

  it('a title change carries the section, the new title and what it was', () => {
    const prompt = cardNextRoundPrompt({
      label: 'C-12',
      change: cardChange(before, { ...before, title: 'Add SSO' }),
      feedback: null,
    });
    expect(prompt).toContain('## Card changed');
    expect(prompt).toContain(
      'The person edited card C-12 after your last round. The text below replaces what you were given before.',
    );
    expect(prompt).toContain('Title: Add SSO (was: Add login)');
    expect(prompt).not.toContain('### What to do');
    expect(prompt).toContain(
      'Continue the work with the card as it is now, on the same branch; commit, then call finish_card.',
    );
  });

  it('a body change carries the full body and the title without "was"', () => {
    const body = 'Users sign in with SSO.\n\n- Google\n- GitHub';
    const prompt = cardNextRoundPrompt({
      label: 'C-12',
      change: cardChange(before, { ...before, body }),
      feedback: null,
    });
    expect(prompt).toContain('Title: Add login\n');
    expect(prompt).not.toContain('(was:');
    expect(prompt).toContain(`### What to do\n\n${body}`);
  });

  it('a kind change names both kinds', () => {
    const prompt = cardNextRoundPrompt({
      label: 'C-12',
      change: cardChange(before, { ...before, kind: 'bug' }),
      feedback: null,
    });
    expect(prompt).toContain('Kind: bug fix (was: feature)');
  });

  it('a change with feedback carries both, the section first', () => {
    const prompt = cardNextRoundPrompt({
      label: 'C-12',
      change: cardChange(before, { ...before, title: 'Add SSO' }),
      feedback: 'Rename the button.',
    });
    expect(prompt.indexOf('## Card changed')).toBeLessThan(
      prompt.indexOf('## Review feedback'),
    );
    expect(prompt).toContain(
      '## Review feedback\n\nRename the button.\n\nAddress it on the same branch, commit, then call finish_card.',
    );
    expect(prompt).not.toContain('Continue the work');
  });

  it('fits card.run at the largest body and feedback, the feedback intact', () => {
    const feedback = '語'.repeat(CARD_FEEDBACK_MAX);
    const title = '語'.repeat(BOARD_CARD_TITLE_MAX);
    const prompt = cardNextRoundPrompt({
      label: 'C-999999',
      change: cardChange(before, {
        title,
        body: '語'.repeat(BOARD_CARD_BODY_MAX),
        kind: 'bug',
      }),
      feedback,
    });
    expect(bytes(prompt)).toBeLessThanOrEqual(CARD_RUN_PROMPT_MAX_BYTES);
    expect(cardPromptSchema.safeParse(prompt).success).toBe(true);
    expect(prompt).toContain(feedback);
    expect(prompt).toContain(`Title: ${title} (was: Add login)`);
    expect(prompt).toContain(CARD_BODY_CUT_SUFFIX);
  });

  it('does not cut a body that fits', () => {
    const body = '語'.repeat(BOARD_CARD_BODY_MAX);
    const prompt = cardNextRoundPrompt({
      label: 'C-12',
      change: cardChange(before, { ...before, body }),
      feedback: null,
    });
    expect(prompt).toContain(body);
    expect(prompt).not.toContain(CARD_BODY_CUT_SUFFIX);
  });
});
