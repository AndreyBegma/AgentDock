import { describe, expect, it } from 'bun:test';
import {
  parseNormalizeOutput,
  resolveNormalizedFields,
  TEXT_FENCE_INFO,
  type TextOutputExpectation,
  textViolationError,
} from './normalize-contract';
import { prepareTextFields } from './normalize-prompt';

const block = (json: unknown) =>
  `Here you go.\n\n\`\`\`${TEXT_FENCE_INFO}\n${JSON.stringify(json)}\n\`\`\`\n`;

const card: TextOutputExpectation = {
  ids: ['title', 'body'],
  classifyKind: true,
};
const comment: TextOutputExpectation = { ids: ['body'], classifyKind: false };

const reasonOf = (text: string, expected: TextOutputExpectation) => {
  const result = parseNormalizeOutput(text, expected);
  return result.ok ? null : result.reason;
};

describe('parseNormalizeOutput', () => {
  it('accepts one block answering every id, with kind when asked', () => {
    const result = parseNormalizeOutput(
      block({
        fields: [
          { id: 'title', english: 'Fix the ⟦1⟧ button', alreadyEnglish: false },
          { id: 'body', alreadyEnglish: true },
        ],
        kind: 'bug',
      }),
      card,
    );
    expect(result).toEqual({
      ok: true,
      output: {
        fields: [
          { id: 'title', english: 'Fix the ⟦1⟧ button', alreadyEnglish: false },
          { id: 'body', alreadyEnglish: true },
        ],
        kind: 'bug',
      },
    });
  });

  it('refuses no block, two blocks and an unclosed block', () => {
    const one = block({ fields: [{ id: 'body', alreadyEnglish: true }] });
    expect(reasonOf('Just text.', comment)).toBe('no_block');
    expect(reasonOf(one + one, comment)).toBe('multiple_blocks');
    expect(reasonOf(`\`\`\`${TEXT_FENCE_INFO}\n{"fields": []}`, comment)).toBe(
      'unterminated_block',
    );
  });

  it('refuses bad JSON and a wrong shape', () => {
    expect(
      reasonOf(`\`\`\`${TEXT_FENCE_INFO}\n{fields:}\n\`\`\``, comment),
    ).toBe('invalid_json');
    expect(reasonOf(block({ fields: 'body' }), comment)).toBe('invalid_shape');
    expect(
      reasonOf(
        block({ fields: [{ id: 'body', alreadyEnglish: false }] }),
        comment,
      ),
    ).toBe('invalid_shape');
    expect(
      reasonOf(
        block({
          fields: [{ id: 'body', alreadyEnglish: true, extra: 1 }],
        }),
        comment,
      ),
    ).toBe('invalid_shape');
    expect(
      reasonOf(
        block({
          fields: [
            { id: 'title', alreadyEnglish: true },
            { id: 'body', alreadyEnglish: true },
          ],
          kind: 'chore',
        }),
        card,
      ),
    ).toBe('invalid_shape');
  });

  it('refuses a missing, an extra or a repeated id', () => {
    expect(
      reasonOf(
        block({ fields: [{ id: 'title', alreadyEnglish: true }], kind: 'bug' }),
        card,
      ),
    ).toBe('missing_field');
    expect(
      reasonOf(
        block({
          fields: [
            { id: 'body', alreadyEnglish: true },
            { id: 'title', alreadyEnglish: true },
          ],
        }),
        comment,
      ),
    ).toBe('unknown_field');
    expect(
      reasonOf(
        block({
          fields: [
            { id: 'body', alreadyEnglish: true },
            { id: 'body', alreadyEnglish: true },
          ],
        }),
        comment,
      ),
    ).toBe('duplicate_field');
  });

  it('refuses kind when not asked, and its absence when asked', () => {
    expect(
      reasonOf(
        block({ fields: [{ id: 'body', alreadyEnglish: true }], kind: 'bug' }),
        comment,
      ),
    ).toBe('unexpected_kind');
    expect(
      reasonOf(
        block({
          fields: [
            { id: 'title', alreadyEnglish: true },
            { id: 'body', alreadyEnglish: true },
          ],
        }),
        card,
      ),
    ).toBe('missing_kind');
  });

  it('asks for the kind only, with no field', () => {
    const result = parseNormalizeOutput(
      block({ fields: [], kind: 'feature' }),
      {
        ids: [],
        classifyKind: true,
      },
    );
    expect(result.ok).toBe(true);
  });

  it('writes an error that never quotes the text', () => {
    const result = parseNormalizeOutput(
      block({ fields: [{ id: 'body', english: 42, alreadyEnglish: false }] }),
      comment,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(textViolationError(result)).toBe(
        'contract_violation: invalid_shape — invalid fields: fields.0.english',
      );
    }
  });
});

describe('resolveNormalizedFields (D6: a placeholder defect rejects one field)', () => {
  const fields = prepareTextFields([
    { field: 'title', text: 'Почини `login()` в src/auth.ts' },
    { field: 'body', text: 'Кнопка не работает' },
  ]);

  it('restores the spans byte for byte into the translation', () => {
    expect(fields[0].masked).toBe('Почини ⟦1⟧ в ⟦2⟧');
    expect(
      resolveNormalizedFields(fields, {
        fields: [
          { id: 'title', english: 'Fix ⟦1⟧ in ⟦2⟧', alreadyEnglish: false },
          {
            id: 'body',
            english: 'The button does not work',
            alreadyEnglish: false,
          },
        ],
      }),
    ).toEqual([
      {
        id: 'title',
        outcome: 'translated',
        english: 'Fix `login()` in src/auth.ts',
      },
      {
        id: 'body',
        outcome: 'translated',
        english: 'The button does not work',
      },
    ]);
  });

  it('rejects a field that lost, repeated or invented a placeholder, and applies the others', () => {
    for (const english of [
      'Fix ⟦1⟧',
      'Fix ⟦1⟧ ⟦1⟧ in ⟦2⟧',
      'Fix ⟦1⟧ in ⟦2⟧ ⟦3⟧',
    ]) {
      expect(
        resolveNormalizedFields(fields, {
          fields: [
            { id: 'title', english, alreadyEnglish: false },
            {
              id: 'body',
              english: 'The button does not work',
              alreadyEnglish: false,
            },
          ],
        }),
      ).toEqual([
        { id: 'title', outcome: 'rejected' },
        {
          id: 'body',
          outcome: 'translated',
          english: 'The button does not work',
        },
      ]);
    }
  });

  it('treats alreadyEnglish, or an unchanged text, as already English', () => {
    const english = prepareTextFields([{ field: 'body', text: 'Ok `x`' }]);
    expect(
      resolveNormalizedFields(english, {
        fields: [{ id: 'body', english: 'Ok ⟦1⟧', alreadyEnglish: false }],
      }),
    ).toEqual([{ id: 'body', outcome: 'already_english' }]);
    expect(
      resolveNormalizedFields(fields.slice(1), {
        fields: [{ id: 'body', alreadyEnglish: true }],
      }),
    ).toEqual([{ id: 'body', outcome: 'already_english' }]);
  });
});
