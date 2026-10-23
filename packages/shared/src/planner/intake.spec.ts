import { describe, expect, it } from 'bun:test';
import {
  CARD_DRAFT_SECTIONS,
  CARD_DRAFT_TITLE_MAX,
  cardDraftSchema,
  checkRoundAnswers,
  INTAKE_SPLIT_MAX,
  INTAKE_SPLIT_MIN,
  type IntakeTurnState,
  intakeMustGenerate,
  intakeOutputSchema,
  intakeRoundsAsked,
  isCardDraftEnglish,
  isIntakeCard,
  isIntakeRound,
  isIntakeSplit,
  isIntakeStack,
  missingCardSections,
  PLAN_MODES,
  PLAN_STATUSES,
  PLANNER_CONTRACT_VERSION,
  PLANNER_INTAKE_CONTRACT,
  PLANNER_INTAKE_MAX_ROUNDS,
  PLANNER_MAX_QUESTIONS,
  type PlannerViolationReason,
  type PlanQuestion,
  type PlanTurnView,
  parsePlannerOutput,
  planAnswerSchema,
  plannerOutputContract,
  planQuestionSchema,
  planTurnInputSchema,
  recommendedAnswer,
  splitCardDraftSchema,
  withRecommendations,
} from '../index';

/** #337 (docs/specs/337-planner-on-the-board.md): the card intake's contract. */

const fence = (json: unknown): string =>
  `Вот что я думаю.\n\n\`\`\`agentdock-plan\n${JSON.stringify(json, null, 2)}\n\`\`\``;

const question = (
  id: string,
  over: Partial<PlanQuestion> = {},
): PlanQuestion => ({
  id,
  title: 'Где хранить',
  question: 'Где хранятся черновики?',
  options: [
    { id: 'db', label: 'База данных' },
    { id: 'gh', label: 'GitHub' },
    { id: 'fs', label: 'Файлы' },
  ],
  recommendation: {
    optionId: 'db',
    text: 'База данных',
    why: 'Ничего не утечёт.',
  },
  blocking: false,
  ...over,
});

const ENGLISH_BODY = [
  '## What to do',
  '',
  'Let a person export the board as a CSV file from the board menu.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] The export holds every card of the board with its column.',
  '- [ ] A viewer can export as well.',
  '',
  '## Out of scope',
  '',
  'Importing a CSV file back into the board.',
  '',
  '## Open questions',
  '',
  '- Which delimiter? Default taken: a comma.',
].join('\n');

const cardDraft = (over: Record<string, unknown> = {}) => ({
  title: 'Export the board as CSV',
  kind: 'feature',
  body: ENGLISH_BODY,
  ...over,
});

const round = { action: 'intake', questions: [question('q1')] };
const card = { action: 'intake', cardDraft: cardDraft() };

const fresh: IntakeTurnState = { roundsAsked: 0, generate: false };

const reasonOf = (
  json: unknown,
  state: IntakeTurnState = fresh,
): PlannerViolationReason | null => {
  const result = parsePlannerOutput(fence(json), 'intake', state);
  return result.ok ? null : result.error.reason;
};

describe('the card mode', () => {
  it('is a plan mode, and a plan that made its cards is done', () => {
    expect(PLAN_MODES).toContain('card');
    expect(PLAN_STATUSES).toContain('done');
  });
});

describe('an intake turn: a round or the card (D1, D4)', () => {
  it('accepts a round while rounds remain', () => {
    const result = parsePlannerOutput(fence(round), 'intake', fresh);
    expect(result.ok).toBe(true);
    if (result.ok && 'questions' in result.output) {
      expect(result.output.questions[0]?.id).toBe('q1');
    }
  });

  it('accepts the card at any point', () => {
    for (const roundsAsked of [0, 2, PLANNER_INTAKE_MAX_ROUNDS]) {
      expect(reasonOf(card, { roundsAsked, generate: false })).toBeNull();
    }
    expect(reasonOf(card, { roundsAsked: 0, generate: true })).toBeNull();
  });

  it('refuses both a round and the card, and neither', () => {
    expect(
      reasonOf({
        action: 'intake',
        questions: [question('q1')],
        cardDraft: cardDraft(),
      }),
    ).toBe('unknown_key');
    expect(reasonOf({ action: 'intake' })).toBe('invalid_shape');
  });

  it('refuses an empty round and an oversized one', () => {
    expect(reasonOf({ action: 'intake', questions: [] })).toBe('invalid_shape');
    const many = Array.from({ length: PLANNER_MAX_QUESTIONS + 1 }, (_, i) =>
      question(`q${i}`),
    );
    expect(reasonOf({ action: 'intake', questions: many })).toBe(
      'too_many_questions',
    );
  });

  it('refuses another action', () => {
    expect(reasonOf({ ...round, action: 'clarify' })).toBe('action_mismatch');
  });
});

describe('the round cap (D4): a fifth round is never asked', () => {
  it('allows rounds 1 to 4', () => {
    for (let asked = 0; asked < PLANNER_INTAKE_MAX_ROUNDS; asked += 1) {
      expect(intakeMustGenerate({ roundsAsked: asked, generate: false })).toBe(
        false,
      );
      expect(
        reasonOf(round, { roundsAsked: asked, generate: false }),
      ).toBeNull();
    }
  });

  it('after four rounds the next turn must generate', () => {
    expect(PLANNER_INTAKE_MAX_ROUNDS).toBe(4);
    const after = { roundsAsked: PLANNER_INTAKE_MAX_ROUNDS, generate: false };
    expect(intakeMustGenerate(after)).toBe(true);
    expect(reasonOf(round, after)).toBe('must_generate');
    expect(reasonOf(round, { roundsAsked: 9, generate: false })).toBe(
      'must_generate',
    );
  });

  it('counts the succeeded turns that opened a round', () => {
    const turn = (
      over: Partial<Pick<PlanTurnView, 'action' | 'phase' | 'rounds'>>,
    ): Pick<PlanTurnView, 'action' | 'phase' | 'rounds'> => ({
      action: 'intake',
      phase: 'succeeded',
      rounds: [{ taskKey: null, questions: [question('q1')] }],
      ...over,
    });
    expect(
      intakeRoundsAsked([
        turn({}),
        turn({}),
        turn({ phase: 'failed', rounds: [] }),
        turn({ phase: 'running', rounds: [] }),
        turn({ rounds: [] }),
        turn({ action: 'clarify' }),
      ]),
    ).toBe(2);
  });
});

describe('Enough — generate (D3)', () => {
  it('makes the next turn generate, even before the first round', () => {
    const enough = { roundsAsked: 0, generate: true };
    expect(intakeMustGenerate(enough)).toBe(true);
    expect(reasonOf(round, enough)).toBe('must_generate');
    expect(reasonOf(card, enough)).toBeNull();
  });

  it('is part of the stored turn input', () => {
    expect(planTurnInputSchema.safeParse({ generate: true }).success).toBe(
      true,
    );
  });

  it('sends the unanswered questions as their recommendations', () => {
    const q1 = question('q1');
    const q2 = question('q2', {
      options: [],
      recommendation: { text: 'Хранить неделю', why: 'Хватит.' },
    });
    const q3 = question('q3', { multiple: true });
    const given = [{ questionId: 'q3', optionIds: ['gh', 'fs'] }];
    expect(withRecommendations([q1, q2, q3], given)).toEqual([
      { questionId: 'q1', optionId: 'db' },
      { questionId: 'q2', text: 'Хранить неделю' },
      { questionId: 'q3', optionIds: ['gh', 'fs'] },
    ]);
    expect(recommendedAnswer(q1)).toEqual({ questionId: 'q1', optionId: 'db' });
  });
});

describe('the generated card (D5, D6)', () => {
  it('names the four sections in order', () => {
    expect(CARD_DRAFT_SECTIONS).toEqual([
      'What to do',
      'Acceptance criteria',
      'Out of scope',
      'Open questions',
    ]);
  });

  it('needs every section', () => {
    for (const section of CARD_DRAFT_SECTIONS) {
      const body = ENGLISH_BODY.replace(`## ${section}`, `### ${section}`);
      expect(
        reasonOf({ action: 'intake', cardDraft: cardDraft({ body }) }),
      ).toBe('missing_card_section');
    }
  });

  it('caps the title at 80 characters and knows the kind', () => {
    const at = 'x'.repeat(CARD_DRAFT_TITLE_MAX);
    expect(
      reasonOf({ action: 'intake', cardDraft: cardDraft({ title: at }) }),
    ).toBeNull();
    expect(
      reasonOf({ action: 'intake', cardDraft: cardDraft({ title: `${at}x` }) }),
    ).toBe('invalid_shape');
    expect(
      reasonOf({ action: 'intake', cardDraft: cardDraft({ kind: 'chore' }) }),
    ).toBe('invalid_shape');
  });

  it('is English: a Russian title or body is refused', () => {
    expect(
      reasonOf({
        action: 'intake',
        cardDraft: cardDraft({ title: 'Экспорт доски в CSV' }),
      }),
    ).toBe('not_english');
    const russian = ENGLISH_BODY.replace(
      'Let a person export the board as a CSV file from the board menu.',
      'Дать человеку выгрузить доску в CSV из меню доски.',
    );
    expect(
      reasonOf({ action: 'intake', cardDraft: cardDraft({ body: russian }) }),
    ).toBe('not_english');
  });

  it('takes a non-English card after the one re-ask', () => {
    const json = {
      action: 'intake',
      cardDraft: cardDraft({ title: 'Экспорт доски в CSV' }),
    };
    expect(reasonOf(json, { ...fresh, acceptNonEnglish: true })).toBeNull();
  });

  it('does not let the English headings carry a body in another language', () => {
    const spanish = [
      '## What to do',
      'Permitir exportar el tablero como archivo CSV desde el menu principal',
      '## Acceptance criteria',
      '- Exporta cada tarjeta con su columna y su titulo',
      '## Out of scope',
      'Importar el archivo de nuevo',
      '## Open questions',
      '- Separador: coma',
    ].join('\n');
    expect(
      isCardDraftEnglish({ title: 'Export the board', body: spanish }),
    ).toBe(false);
    expect(
      isCardDraftEnglish({ title: 'Export the board', body: ENGLISH_BODY }),
    ).toBe(true);
  });

  it('takes a heading closed by hashes and trailing blanks', () => {
    const body = ENGLISH_BODY.replace(
      '## Out of scope',
      '##\tOut of scope \t## \t',
    ).replace('## Open questions', '## open questions\r');
    expect(missingCardSections(body)).toEqual([]);
    expect(
      missingCardSections(
        ENGLISH_BODY.replace('## Out of scope', '## Out of scope now'),
      ),
    ).toEqual(['Out of scope']);
  });

  // WI-61: the heading match ran `[ \t]*#*[ \t]*$`, quadratic on a long run
  // of blanks after a heading.
  it.each([
    ['blanks', `## What to do${' \t'.repeat(50_000)}x`],
    ['hashes', `## What to do ${'#'.repeat(100_000)}x`],
  ])('checks a 100 KB run of %s after a heading in under 50 ms', (_, body) => {
    const started = performance.now();
    expect(missingCardSections(body)).toEqual([...CARD_DRAFT_SECTIONS]);
    isCardDraftEnglish({ title: 'Export the board', body });
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('multiple choice and the free answer (D3)', () => {
  it('a question may be multiple choice', () => {
    expect(
      planQuestionSchema.safeParse(question('q1', { multiple: true })).success,
    ).toBe(true);
    expect(
      parsePlannerOutput(
        fence({
          action: 'intake',
          questions: [question('q1', { multiple: true })],
        }),
        'intake',
        fresh,
      ).ok,
    ).toBe(true);
  });

  it('an answer carries optionIds, not with optionId, unique', () => {
    expect(
      planAnswerSchema.safeParse({ questionId: 'q1', optionIds: ['db', 'gh'] })
        .success,
    ).toBe(true);
    expect(
      planAnswerSchema.safeParse({
        questionId: 'q1',
        optionId: 'db',
        optionIds: ['gh'],
      }).success,
    ).toBe(false);
    expect(
      planAnswerSchema.safeParse({ questionId: 'q1', optionIds: ['db', 'db'] })
        .success,
    ).toBe(false);
    expect(
      planAnswerSchema.safeParse({ questionId: 'q1', optionIds: [] }).success,
    ).toBe(false);
  });

  it('a multiple question accepts two options; a single one refuses them', () => {
    const multiple = question('q1', { multiple: true });
    const single = question('q2');
    expect(
      checkRoundAnswers(
        [multiple],
        [{ questionId: 'q1', optionIds: ['db', 'gh'] }],
      ),
    ).toEqual({ ok: true });
    const refused = checkRoundAnswers(
      [single],
      [{ questionId: 'q2', optionIds: ['db', 'gh'] }],
    );
    expect(refused.ok).toBe(false);
    expect(
      checkRoundAnswers([single], [{ questionId: 'q2', optionIds: ['db'] }]),
    ).toEqual({ ok: true });
  });

  it('the free answer is accepted on every question, options or not', () => {
    const withOptions = question('q1');
    const multiple = question('q2', { multiple: true });
    expect(
      checkRoundAnswers(
        [withOptions, multiple],
        [
          { questionId: 'q1', text: 'В Redis' },
          { questionId: 'q2', optionIds: ['db'], text: 'и ещё S3' },
        ],
      ),
    ).toEqual({ ok: true });
  });

  it('refuses an unknown option, a stranger question and a double answer', () => {
    const q1 = question('q1');
    expect(
      checkRoundAnswers([q1], [{ questionId: 'q1', optionId: 'zz' }]).ok,
    ).toBe(false);
    expect(checkRoundAnswers([q1], [{ questionId: 'q9', text: 'x' }]).ok).toBe(
      false,
    );
    expect(
      checkRoundAnswers(
        [q1],
        [
          { questionId: 'q1', optionId: 'db' },
          { questionId: 'q1', optionId: 'gh' },
        ],
      ).ok,
    ).toBe(false);
  });
});

describe('the contract text', () => {
  it('v3 offers multiple choice; v2 does not', () => {
    expect(PLANNER_CONTRACT_VERSION).toBe(3);
    expect(plannerOutputContract(3)).toContain('"multiple"?: boolean');
    expect(plannerOutputContract(2)).not.toContain('multiple');
  });

  it('the intake text states the cap, the sections, the languages', () => {
    expect(PLANNER_INTAKE_CONTRACT).toContain(
      `At most ${PLANNER_INTAKE_MAX_ROUNDS} rounds`,
    );
    for (const section of CARD_DRAFT_SECTIONS) {
      expect(PLANNER_INTAKE_CONTRACT).toContain(`## ${section}`);
    }
    expect(PLANNER_INTAKE_CONTRACT).toContain('in English');
    expect(PLANNER_INTAKE_CONTRACT).toContain('"multiple"?: boolean');
    expect(PLANNER_INTAKE_CONTRACT).toContain('"cardDraft": CardDraft');
  });

  it('the intake text offers the split and keep-one rules (#409)', () => {
    expect(PLANNER_INTAKE_CONTRACT).toContain('"split": Split');
    expect(PLANNER_INTAKE_CONTRACT).toContain(
      `${INTAKE_SPLIT_MIN}–${INTAKE_SPLIT_MAX}`,
    );
    expect(PLANNER_INTAKE_CONTRACT).toContain('keep one card');
    expect(PLANNER_INTAKE_CONTRACT).not.toContain('New Plan');
  });
});

/** #409 (docs/specs/409-new-work-intake-can-split.md): the split proposal. */
describe('an intake turn may propose a split (#409)', () => {
  const splitCard = (title: string, over: Record<string, unknown> = {}) => ({
    ...cardDraft({ title }),
    summary: `${title}, on its own card.`,
    ...over,
  });
  const split = (cards: unknown[]) => ({
    action: 'intake',
    split: { reason: 'Это две независимые задачи.', cards },
  });
  const two = [
    splitCard('Export the board as CSV'),
    splitCard('Import the board from CSV'),
  ];

  it('takes two to eight independent cards', () => {
    const result = parsePlannerOutput(fence(split(two)), 'intake', fresh);
    expect(result.ok).toBe(true);
    if (result.ok && 'split' in result.output) {
      expect(result.output.split.cards.map((c) => c.title)).toEqual([
        'Export the board as CSV',
        'Import the board from CSV',
      ]);
    }
    const eight = Array.from({ length: INTAKE_SPLIT_MAX }, (_, i) =>
      splitCard(`Export the board as CSV, part ${i + 1}`),
    );
    expect(reasonOf(split(eight))).toBeNull();
  });

  it('refuses one card, more than eight, or a card without its summary', () => {
    expect(reasonOf(split([two[0]]))).toBe('invalid_shape');
    const nine = Array.from({ length: INTAKE_SPLIT_MAX + 1 }, (_, i) =>
      splitCard(`Export part ${i + 1}`),
    );
    expect(reasonOf(split(nine))).toBe('invalid_shape');
    const { summary: _summary, ...bare } = two[0];
    expect(reasonOf(split([bare, two[1]]))).toBe('invalid_shape');
  });

  it('holds every card to the card rules: the sections and English', () => {
    expect(
      reasonOf(
        split([
          two[0],
          splitCard('Import the board from CSV', { body: 'Just do it.' }),
        ]),
      ),
    ).toBe('missing_card_section');
    expect(reasonOf(split([two[0], splitCard('Импорт доски из CSV')]))).toBe(
      'not_english',
    );
    expect(
      reasonOf(split([two[0], splitCard('Импорт доски из CSV')]), {
        ...fresh,
        acceptNonEnglish: true,
      }),
    ).toBeNull();
  });

  it('may answer Enough — generate or the last round', () => {
    expect(reasonOf(split(two), { roundsAsked: 0, generate: true })).toBeNull();
    expect(
      reasonOf(split(two), {
        roundsAsked: PLANNER_INTAKE_MAX_ROUNDS,
        generate: false,
      }),
    ).toBeNull();
  });

  it('after Keep one card, only the one card passes', () => {
    const keepOne: IntakeTurnState = { ...fresh, keepOne: true };
    expect(intakeMustGenerate(keepOne)).toBe(true);
    expect(reasonOf(split(two), keepOne)).toBe('split_declined');
    expect(reasonOf(round, keepOne)).toBe('must_generate');
    expect(reasonOf(card, keepOne)).toBeNull();
  });

  it('is told apart from a round and a card', () => {
    const output = intakeOutputSchema.parse(split(two));
    expect(isIntakeSplit(output)).toBe(true);
    expect(isIntakeCard(output)).toBe(false);
    expect(isIntakeRound(output)).toBe(false);
    expect(isIntakeSplit(intakeOutputSchema.parse(card))).toBe(false);
  });

  it('a turn input carries Keep one card', () => {
    expect(planTurnInputSchema.parse({ keepOne: true })).toEqual({
      keepOne: true,
    });
  });
});

/** #480 (ADR-0044): the stack proposal — cards in ordered stages. */
describe('an intake turn may propose a stack (#480)', () => {
  const stackCard = (title: string, over: Record<string, unknown> = {}) => ({
    ...cardDraft({ title }),
    summary: `${title}, as one part of the page.`,
    ...over,
  });
  const stack = (stages: unknown[], over: Record<string, unknown> = {}) => ({
    action: 'intake',
    stack: {
      reason: 'Одна страница: сначала компоненты, потом страница.',
      title: 'Redesign the settings page',
      body: 'Move the settings page to the new layout: the components come first, then the page that is built from them.',
      design: true,
      stages,
      ...over,
    },
  });
  const twoStages = [
    {
      title: 'Components',
      cards: [stackCard('Add the toggle row to the kit')],
    },
    { title: 'Page', cards: [stackCard('Compose the settings page')] },
  ];

  it('takes cards in two or more stages and is told apart from a split', () => {
    const result = parsePlannerOutput(fence(stack(twoStages)), 'intake', fresh);
    expect(result.ok).toBe(true);
    const output = intakeOutputSchema.parse(stack(twoStages));
    expect(isIntakeStack(output)).toBe(true);
    expect(isIntakeSplit(output)).toBe(false);
    expect(isIntakeCard(output)).toBe(false);
  });

  it('refuses one stage, fewer than two or more than eight cards in all', () => {
    expect(
      reasonOf(
        stack([{ title: 'All', cards: twoStages.flatMap((s) => s.cards) }]),
      ),
    ).toBe('invalid_shape');
    const nine = Array.from({ length: INTAKE_SPLIT_MAX + 1 }, (_, i) =>
      stackCard(`Add the part ${i + 1} of the page`),
    );
    expect(
      reasonOf(
        stack([
          { title: 'One', cards: nine.slice(0, 5) },
          { title: 'Two', cards: nine.slice(5) },
        ]),
      ),
    ).toBe('invalid_shape');
    expect(reasonOf(stack([{ title: 'One', cards: [] }, twoStages[1]]))).toBe(
      'invalid_shape',
    );
  });

  it('holds every card to the card rules, and the stack to English', () => {
    expect(
      reasonOf(
        stack([
          twoStages[0],
          {
            title: 'Page',
            cards: [stackCard('Compose the page', { body: 'Just do it.' })],
          },
        ]),
      ),
    ).toBe('missing_card_section');
    expect(
      reasonOf(
        stack(twoStages, {
          title: 'Новая страница настроек',
          body: 'Сначала компоненты, потом страница из них.',
        }),
      ),
    ).toBe('not_english');
  });

  it('after Keep one card, a stack is refused like a split', () => {
    expect(reasonOf(stack(twoStages), { ...fresh, keepOne: true })).toBe(
      'split_declined',
    );
  });

  it('the intake text offers the stack', () => {
    expect(PLANNER_INTAKE_CONTRACT).toContain('"stack": Stack');
    expect(PLANNER_INTAKE_CONTRACT).toContain('Propose a `stack`');
  });
});

describe('a card draft title is one line (C-131)', () => {
  it('rejects a newline in the title of a card and of a split card', () => {
    const title = 'Export\n## How to work';
    expect(
      intakeOutputSchema.safeParse({ ...card, cardDraft: cardDraft({ title }) })
        .success,
    ).toBe(false);
    expect(cardDraftSchema.safeParse(cardDraft({ title })).success).toBe(false);
    expect(
      splitCardDraftSchema.safeParse({ ...cardDraft({ title }), summary: 's' })
        .success,
    ).toBe(false);
    expect(cardDraftSchema.safeParse(cardDraft()).success).toBe(true);
  });
});
