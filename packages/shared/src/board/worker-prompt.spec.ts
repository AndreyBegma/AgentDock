import { describe, expect, it } from 'bun:test';
import {
  ATTACHMENT_NAME_MAX,
  ATTACHMENTS_PER_CARD_MAX,
  attachmentWorktreePath,
  type CardAttachmentBrief,
} from '../attachments';
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
  CARD_PR_DESCRIPTION_FILE,
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
  'login-form',
);
const frames = [{ name: 'Login form', path }];

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
    frames,
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
      'docs/specs/card-12-add-login/design/2/login-form.html (already committed on this branch',
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
        design: { frames, rationale: '  ', comments: [] },
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
        design: { frames, rationale: '', comments: Array(6).fill(comment) },
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
        frames: [
          {
            name: 'Mockup',
            path: `${'d/'.repeat(100)}card-999999-${'a'.repeat(40)}/design/3/mockup.html`,
          },
        ],
        rationale: '語'.repeat(DESIGN_RATIONALE_MAX),
        comments: Array(20).fill('語'.repeat(500)),
      },
    });
    expect(bytes(prompt)).toBeLessThanOrEqual(CARD_RUN_PROMPT_MAX_BYTES);
    expect(cardPromptSchema.safeParse(prompt).success).toBe(true);
    expect(prompt).toContain(body);
    expect(prompt).toContain('/design/3/mockup.html');
    expect(prompt).toContain('more not shown');
  });

  it('keeps the whole rationale when the card is short', () => {
    const rationale = '語'.repeat(DESIGN_RATIONALE_MAX);
    const prompt = cardWorkerPrompt({
      ...card,
      design: { frames, rationale, comments: [] },
    });
    expect(prompt).toContain(`Why this design: ${rationale}`);
  });

  it('lists every frame of the approved variant with its name (#441)', () => {
    const many = ['Board page', 'Card page', 'Frame tabs'].map((name, i) => ({
      name,
      path: `docs/specs/card-12-add-login/design/2/f${i}.html`,
    }));
    const prompt = cardWorkerPrompt({
      ...card,
      design: { frames: many, rationale: '', comments: [] },
    });
    const section = sectionOf(prompt);
    expect(section).toContain('The approved design has 3 frames');
    expect(section).toContain('open them first');
    for (const f of many) expect(section).toContain(`- ${f.path} — ${f.name}`);
    expect(prompt).toContain(
      'Design: https://github.com/<owner>/<repo>/tree/card/c12-add-login/docs/specs/card-12-add-login/design/2`',
    );
  });

  it('leaves room in card.run for the spec and the approved mockup', () => {
    expect(CARD_RUN_FILES_MAX).toBeGreaterThanOrEqual(2);
    expect(CARD_RUN_FILE_MAX_BYTES).toBeGreaterThanOrEqual(
      DESIGN_HTML_MAX_BYTES,
    );
  });
});

describe('worker prompt v5 — the pull request description (#359 D3)', () => {
  const plain: CardWorkerPromptInput = { ...card, design: null };
  const blob = 'https://github.com/<owner>/<repo>/blob/card/c12-add-login/';

  it('asks for the description file before finish_card, git-excluded and uncommitted', () => {
    const prompt = cardWorkerPrompt(plain);
    expect(CARD_PR_DESCRIPTION_FILE).toBe('.agentdock/pull-request.md');
    const at = prompt.indexOf(`\`${CARD_PR_DESCRIPTION_FILE}\``);
    expect(at).toBeGreaterThan(prompt.indexOf('## When you are done'));
    expect(at).toBeLessThan(prompt.indexOf('Then call the `finish_card` tool'));
    expect(prompt).toContain('git-excluded — do not commit it');
    expect(prompt).toContain('`## What changed and why`');
    expect(prompt).toContain('`## Acceptance criteria`');
    expect(prompt).toContain('`[x]` with how you checked it');
  });

  it('links the spec on the branch, and the design beside it', () => {
    expect(cardWorkerPrompt(plain)).toContain(
      `\`Spec: ${blob}docs/specs/card-12-add-login.md\``,
    );
    expect(cardWorkerPrompt(card)).toContain(
      `\`Spec: ${blob}docs/specs/card-12-add-login.md · Design: ${blob}${path}\``,
    );
    expect(cardWorkerPrompt({ ...plain, specPath: null })).not.toContain(
      '`Spec:',
    );
  });

  it('asks for Closes #n only when the card has an issue', () => {
    expect(cardWorkerPrompt(plain)).not.toContain('Closes #');
    expect(cardWorkerPrompt({ ...plain, issueNumber: 41 })).toContain(
      '`Closes #41`',
    );
  });
});

describe('next round prompt — card edits reach the worker (#273 D1–D4)', () => {
  const before: CardText = {
    title: 'Add login',
    body: 'Users sign in with a password.',
    kind: 'feature',
  };

  it('is version 8', () => {
    expect(CARD_WORKER_PROMPT_VERSION).toBe(8);
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

describe('worker prompt v4 — attachments (#309 D10)', () => {
  const shot: CardAttachmentBrief = {
    id: 'att1',
    name: 'login error.png',
    mime: 'image/png',
  };
  const log: CardAttachmentBrief = {
    id: 'att2',
    name: 'server.log',
    mime: 'text/plain',
  };
  const spec: CardAttachmentBrief = {
    id: 'att3',
    name: 'brief.pdf',
    mime: 'application/pdf',
  };
  const text: CardText = {
    title: 'Add login',
    body: 'Users sign in with a password.',
    kind: 'feature',
  };

  it('has no attachments section without attachments', () => {
    expect(cardWorkerPrompt(card)).not.toContain('## Attachments');
    expect(cardWorkerPrompt({ ...card, attachments: [] })).not.toContain(
      '## Attachments',
    );
  });

  it('lists each attachment by worktree path, type and name, and says to open images with Read', () => {
    const prompt = cardWorkerPrompt({
      ...card,
      attachments: [shot, log, spec],
    });
    expect(prompt).toContain('## Attachments');
    expect(prompt).toContain(
      '- `.agentdock/attachments/att1-login_error.png` (image) — login error.png',
    );
    expect(prompt).toContain(
      '- `.agentdock/attachments/att2-server.log` (text) — server.log',
    );
    expect(prompt).toContain(
      '- `.agentdock/attachments/att3-brief.pdf` (PDF) — brief.pdf',
    );
    expect(prompt).toContain('Open an image with the Read tool');
    expect(prompt).toContain('do not commit');
    expect(prompt.indexOf('## The card')).toBeLessThan(
      prompt.indexOf('## Attachments'),
    );
    expect(prompt.indexOf('## Attachments')).toBeLessThan(
      prompt.indexOf('## How to work'),
    );
  });

  it('every listed path is the one the runner writes', () => {
    const prompt = cardWorkerPrompt({ ...card, attachments: [shot, log] });
    for (const a of [shot, log]) {
      expect(prompt).toContain(attachmentWorktreePath(a.id, a.name));
    }
  });

  it('fits card.run at the largest card with 20 attachments, every path kept', () => {
    const attachments = Array.from(
      { length: ATTACHMENTS_PER_CARD_MAX },
      (_, i): CardAttachmentBrief => ({
        id: `cm1attachment${String(i).padStart(12, '0')}`,
        name: `${'語'.repeat(ATTACHMENT_NAME_MAX - 4)}.png`,
        mime: 'image/png',
      }),
    );
    const prompt = cardWorkerPrompt({
      ...card,
      title: '語'.repeat(BOARD_CARD_TITLE_MAX),
      body: '語'.repeat(BOARD_CARD_BODY_MAX),
      attachments,
    });
    expect(bytes(prompt)).toBeLessThanOrEqual(CARD_RUN_PROMPT_MAX_BYTES);
    expect(cardPromptSchema.safeParse(prompt).success).toBe(true);
    for (const a of attachments) {
      expect(prompt).toContain(attachmentWorktreePath(a.id, a.name));
    }
  });

  it('keeps the whole body and the names when they fit', () => {
    const body = '語'.repeat(1000);
    const prompt = cardWorkerPrompt({ ...card, body, attachments: [shot] });
    expect(prompt).toContain(body);
    expect(prompt).toContain('— login error.png');
    expect(prompt).not.toContain(CARD_BODY_CUT_SUFFIX);
  });

  it('cardChange reports attachments added and removed since the last round', () => {
    const change = cardChange(text, text, {
      before: [shot, log],
      now: [log, spec],
    });
    expect(change?.fields).toEqual([]);
    expect(change?.attachments).toEqual({ added: [spec], removed: [shot] });
  });

  it('cardChange is null when neither the text nor the attachments changed', () => {
    expect(cardChange(text, text, { before: [shot], now: [shot] })).toBeNull();
    expect(cardChange(text, text)).toBeNull();
    expect(
      cardChange(text, { ...text, title: 'Add SSO' })?.attachments,
    ).toEqual({ added: [], removed: [] });
  });

  it('a round after an attachment was added says so, with its path', () => {
    const prompt = cardNextRoundPrompt({
      label: 'C-12',
      change: cardChange(text, text, { before: [], now: [shot] }),
      feedback: null,
    });
    expect(prompt).toContain('## Attachments changed');
    expect(prompt).toContain(
      'The person changed the attachments of card C-12 after your last round.',
    );
    expect(prompt).toContain(
      'Added:\n- `.agentdock/attachments/att1-login_error.png` (image) — login error.png',
    );
    expect(prompt).toContain('Open an image with the Read tool');
    expect(prompt).not.toContain('## Card changed');
    expect(prompt).toContain('Continue the work with the card as it is now');
  });

  it('names the removed attachments', () => {
    const prompt = cardNextRoundPrompt({
      label: 'C-12',
      change: cardChange(text, text, { before: [shot], now: [] }),
      feedback: null,
    });
    expect(prompt).toContain('Removed (no longer there — disregard them):');
    expect(prompt).toContain('- login error.png');
    expect(prompt).not.toContain('Added:');
  });

  it('feedback with attachments carries the text change, the attachments, then the feedback', () => {
    const prompt = cardNextRoundPrompt({
      label: 'C-12',
      change: cardChange(
        text,
        { ...text, title: 'Add SSO' },
        { before: [], now: [shot] },
      ),
      feedback: 'See the screenshot.',
    });
    const changed = prompt.indexOf('## Card changed');
    const files = prompt.indexOf('## Attachments changed');
    const feedback = prompt.indexOf('## Review feedback');
    expect(changed).toBeGreaterThanOrEqual(0);
    expect(changed).toBeLessThan(files);
    expect(files).toBeLessThan(feedback);
  });

  it('fits card.run at the largest body and feedback with 20 added attachments', () => {
    const attachments = Array.from(
      { length: ATTACHMENTS_PER_CARD_MAX },
      (_, i): CardAttachmentBrief => ({
        id: `cm1attachment${String(i).padStart(12, '0')}`,
        name: `${'語'.repeat(ATTACHMENT_NAME_MAX - 4)}.png`,
        mime: 'image/png',
      }),
    );
    const feedback = '語'.repeat(CARD_FEEDBACK_MAX);
    const prompt = cardNextRoundPrompt({
      label: 'C-999999',
      change: cardChange(
        text,
        { ...text, body: '語'.repeat(BOARD_CARD_BODY_MAX) },
        { before: [], now: attachments },
      ),
      feedback,
    });
    expect(bytes(prompt)).toBeLessThanOrEqual(CARD_RUN_PROMPT_MAX_BYTES);
    expect(prompt).toContain(feedback);
    for (const a of attachments) {
      expect(prompt).toContain(attachmentWorktreePath(a.id, a.name));
    }
  });
});
