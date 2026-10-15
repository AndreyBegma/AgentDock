import { describe, expect, it } from 'bun:test';
import {
  classifyCardKindEnglish,
  type DeepLAnswer,
  fromDeepLXml,
  isDeepLFinal,
  resolveDeepLFields,
  toDeepLXml,
} from './deepl';
import { prepareTextFields } from './normalize-prompt';

const ru = (text: string): DeepLAnswer => ({
  text,
  detectedSourceLanguage: 'RU',
});

/** The masked field of `text`, as `request()` prepares it. */
const field = (text: string, id = 'body') => {
  const [prepared] = prepareTextFields([{ field: id, text }]);
  return prepared;
};

describe('toDeepLXml / fromDeepLXml', () => {
  it('sends placeholders as ignored tags and escapes the rest', () => {
    expect(toDeepLXml('Если a < b && c > d, см. ⟦1⟧ и ⟦12⟧')).toBe(
      'Если a &lt; b &amp;&amp; c &gt; d, см. <x i="1"/> и <x i="12"/>',
    );
  });

  it('round-trips a masked text byte for byte', () => {
    const masked = 'a < b & "c" > ⟦1⟧\n\n- пункт ⟦2⟧\n';
    expect(fromDeepLXml(toDeepLXml(masked))).toBe(masked);
  });

  it('reads the open-close form and the entities an XML writer may use', () => {
    expect(fromDeepLXml('<x i="3"></x> &quot;q&quot; &apos;&#65;&#x42;')).toBe(
      '⟦3⟧ "q" \'AB',
    );
  });

  it('refuses markup DeepL invented', () => {
    expect(fromDeepLXml('Fix <b>the</b> button <x i="1"/>')).toBeNull();
  });

  it('keeps a literal tag the person typed as text', () => {
    const masked = 'Тег &lt;x i="1"/&gt; это текст';
    expect(fromDeepLXml(toDeepLXml(masked))).toBe(masked);
  });
});

describe('resolveDeepLFields', () => {
  it('restores fenced code, inline code, a URL and #123 byte for byte', () => {
    const text =
      'Почини кнопку `src/run.ts` в #123, см. https://example.com/a?b=1.\n```ts\nconst x = 1 < 2;\n```\nи всё';
    const f = field(text);
    expect(f.spans).toEqual([
      '`src/run.ts`',
      '#123',
      'https://example.com/a?b=1',
      '```ts\nconst x = 1 < 2;\n```',
    ]);
    const sent = toDeepLXml(f.masked);
    // DeepL translates around the tags and keeps them as sent.
    const answer = sent
      .replace('Почини кнопку', 'Fix the button')
      .replace(' в ', ' in ')
      .replace('см.', 'see')
      .replace('и всё', 'and that is it');
    const [result] = resolveDeepLFields([f], [ru(answer)]);
    expect(result).toEqual({
      id: 'body',
      outcome: 'translated',
      english:
        'Fix the button `src/run.ts` in #123, see https://example.com/a?b=1.\n```ts\nconst x = 1 < 2;\n```\nand that is it',
    });
  });

  it('rejects a field whose answer dropped, repeated or invented a tag', () => {
    const f = field('Смотри `a` и `b`');
    expect(f.spans).toHaveLength(2);
    const answers = [
      'See <x i="1"/> and',
      'See <x i="1"/> and <x i="1"/>',
      'See <x i="1"/> and <x i="2"/> <x i="3"/>',
    ];
    for (const answer of answers) {
      expect(resolveDeepLFields([f], [ru(answer)])).toEqual([
        { id: 'body', outcome: 'rejected' },
      ]);
    }
  });

  it('resolves each field on its own', () => {
    const title = field('Кнопка `run`', 'title');
    const body = field('Тело', 'body');
    expect(
      resolveDeepLFields([title, body], [ru('Button'), ru('Body')]),
    ).toEqual([
      { id: 'title', outcome: 'rejected' },
      { id: 'body', outcome: 'translated', english: 'Body' },
    ]);
  });

  it('is already_english when DeepL detected English or changed nothing', () => {
    const f = field('Привет');
    expect(
      resolveDeepLFields([f], [{ text: 'Hi', detectedSourceLanguage: 'EN' }]),
    ).toEqual([{ id: 'body', outcome: 'already_english' }]);
    expect(resolveDeepLFields([f], [ru('Привет')])).toEqual([
      { id: 'body', outcome: 'already_english' },
    ]);
  });

  it('rejects a missing or empty answer', () => {
    const f = field('Привет');
    expect(resolveDeepLFields([f], [])).toEqual([
      { id: 'body', outcome: 'rejected' },
    ]);
    expect(resolveDeepLFields([f], [ru('  ')])).toEqual([
      { id: 'body', outcome: 'rejected' },
    ]);
  });
});

describe('isDeepLFinal', () => {
  it('sends quota and auth straight to the runner', () => {
    expect(isDeepLFinal('quota')).toBe(true);
    expect(isDeepLFinal('auth')).toBe(true);
    expect(isDeepLFinal('timeout')).toBe(false);
    expect(isDeepLFinal('rate')).toBe(false);
    expect(isDeepLFinal('unavailable')).toBe(false);
  });
});

describe('classifyCardKindEnglish', () => {
  it('reads "Кнопка Run падает с ошибкой", translated, as a bug', () => {
    expect(
      classifyCardKindEnglish('The Run button crashes with an error', ''),
    ).toBe('bug');
  });

  it('matches each word of the list, in any case, as a whole word', () => {
    for (const title of [
      'Bug in login',
      'FIX the header',
      'Upload is broken',
      'App crash on start',
      'Fails on save',
      'Failing test',
      "Search doesn't work",
      'Search doesn’t work',
      'Export does not work',
      'Regression in 1.2',
      'Exception when saving',
      'Wrong total',
      'Returns 500',
      'Page 404',
    ]) {
      expect(classifyCardKindEnglish(title, '')).toBe('bug');
    }
  });

  it('is a feature otherwise, and words inside words do not count', () => {
    expect(classifyCardKindEnglish('Add dark mode', 'Users want it.')).toBe(
      'feature',
    );
    expect(classifyCardKindEnglish('Debugger panel', 'Prefix 5000 items')).toBe(
      'feature',
    );
  });

  it('reads only the first 500 characters of the body', () => {
    expect(
      classifyCardKindEnglish('Add export', `${'a '.repeat(240)}crash`),
    ).toBe('bug');
    expect(
      classifyCardKindEnglish('Add export', `${'a '.repeat(260)}crash`),
    ).toBe('feature');
  });
});
