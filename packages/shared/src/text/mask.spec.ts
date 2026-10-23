import { describe, expect, it } from 'bun:test';
import { checkPlaceholders, maskText, unmaskText } from './mask';

const roundTrip = (text: string) => {
  const { masked, spans } = maskText(text);
  expect(unmaskText(masked, spans)).toBe(text);
  return { masked, spans };
};

describe('maskText', () => {
  it('masks fenced blocks with backticks and tildes, byte for byte', () => {
    const text =
      'Почини это:\n```ts\nconst x = 1;\n  // ok\n```\nи ещё\n~~~\nrm -rf dist\n~~~\nконец';
    const { masked, spans } = roundTrip(text);
    expect(masked).toBe('Почини это:\n⟦1⟧\nи ещё\n⟦2⟧\nконец');
    expect(spans).toEqual([
      '```ts\nconst x = 1;\n  // ok\n```',
      '~~~\nrm -rf dist\n~~~',
    ]);
  });

  it('runs an unclosed fence to the end', () => {
    const { masked, spans } = roundTrip('Смотри:\n```\nfoo();\nbar();');
    expect(masked).toBe('Смотри:\n⟦1⟧');
    expect(spans).toEqual(['```\nfoo();\nbar();']);
  });

  it('closes a fence only with the same marker, at least as long', () => {
    const { spans } = roundTrip('````\n```\ninner\n```\n````\nпосле');
    expect(spans).toEqual(['````\n```\ninner\n```\n````']);
  });

  it('masks inline code', () => {
    const { masked, spans } = roundTrip('Вызови `foo()` и ``a ` b`` потом');
    expect(masked).toBe('Вызови ⟦1⟧ и ⟦2⟧ потом');
    expect(spans).toEqual(['`foo()`', '``a ` b``']);
  });

  it('masks URLs without the sentence punctuation after them', () => {
    const { masked, spans } = roundTrip(
      'Смотри https://example.com/a?b=1&c=2. И www.x.io, ладно',
    );
    expect(masked).toBe('Смотри ⟦1⟧. И ⟦2⟧, ладно');
    expect(spans).toEqual(['https://example.com/a?b=1&c=2', 'www.x.io']);
  });

  it('masks e-mail addresses', () => {
    const { spans } = roundTrip('Пиши на dev.team+x@mail.example.org сразу');
    expect(spans).toEqual(['dev.team+x@mail.example.org']);
  });

  it('masks paths, Windows paths and dotfiles', () => {
    const { masked, spans } = roundTrip(
      'Файл src/app/page.tsx, папка C:\\Users\\me и .env.local тоже',
    );
    expect(masked).toBe('Файл ⟦1⟧, папка ⟦2⟧ и ⟦3⟧ тоже');
    expect(spans).toEqual(['src/app/page.tsx', 'C:\\Users\\me', '.env.local']);
  });

  it('keeps a non-ASCII token with a slash translatable', () => {
    const { masked, spans } = roundTrip('Ответь да/нет');
    expect(masked).toBe('Ответь да/нет');
    expect(spans).toEqual([]);
  });

  it('masks identifiers, references and mentions', () => {
    const { masked, spans } = roundTrip(
      'Спроси @andrey про #123 и C-12: userId, snake_case, MAX_SIZE, PrismaService, a.b.c, page.tsx',
    );
    expect(masked).toBe(
      'Спроси ⟦1⟧ про ⟦2⟧ и ⟦3⟧: ⟦4⟧, ⟦5⟧, ⟦6⟧, ⟦7⟧, ⟦8⟧, ⟦9⟧',
    );
    expect(spans).toEqual([
      '@andrey',
      '#123',
      'C-12',
      'userId',
      'snake_case',
      'MAX_SIZE',
      'PrismaService',
      'a.b.c',
      'page.tsx',
    ]);
  });

  it('leaves plain words, in any script, alone', () => {
    const text = 'Кнопка входа не работает. The login button is broken!';
    expect(roundTrip(text)).toEqual({ masked: text, spans: [] });
  });

  it('masks a placeholder already in the input so it survives', () => {
    const { masked, spans } = roundTrip('Было ⟦1⟧ и ⟦x⟧');
    expect(masked).toBe('Было ⟦1⟧ и ⟦2⟧');
    expect(spans).toEqual(['⟦1⟧', '⟦x⟧']);
  });

  it('round-trips arbitrary mixtures', () => {
    for (const text of [
      '',
      '```',
      '`',
      '⟦',
      '⟦\n```\nx\n```\n⟧',
      'a/b/c/ /// \\\\ ..',
      'mixed `code` https://a.b/c?d#e foo_bar.baz() @x #1 Z-9',
      '\r\n```\r\ncrlf\r\n```\r\n',
    ]) {
      roundTrip(text);
    }
  });

  it('splits a path at a slash only after a path character', () => {
    expect(maskText('see a./b now').spans).toEqual([]);
    expect(maskText('see a./b/c, now').spans).toEqual(['a./b/c']);
  });

  // WI-61: these runs made a pattern rescan the text from every position
  // inside them — seconds on 100 KB.
  it.each([
    ['a run of letters', 'a'.repeat(100_000)],
    ['a run of scheme characters', 'a-+'.repeat(33_334)],
    ['a run of e-mail characters', 'a%'.repeat(50_000)],
    ['a path that never ends cleanly', ` ${'a/'.repeat(50_000)}é`],
    ['a path split after punctuation', ` ${'a./'.repeat(33_334)}é`],
    ['an unclosed placeholder run', '⟦'.repeat(100_000)],
  ])('masks %s of 100 KB in under 50 ms', (_, text) => {
    const started = performance.now();
    roundTrip(text);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('checkPlaceholders', () => {
  it('accepts every placeholder exactly once, in any order', () => {
    expect(checkPlaceholders('⟦2⟧ then ⟦1⟧', 2)).toBe(true);
    expect(checkPlaceholders('no code', 0)).toBe(true);
  });

  it('refuses a lost, duplicated or invented placeholder', () => {
    expect(checkPlaceholders('only ⟦1⟧', 2)).toBe(false);
    expect(checkPlaceholders('⟦1⟧ ⟦1⟧ ⟦2⟧', 2)).toBe(false);
    expect(checkPlaceholders('⟦1⟧ ⟦2⟧ ⟦3⟧', 2)).toBe(false);
    expect(checkPlaceholders('⟦0⟧', 0)).toBe(false);
  });
});

describe('unmaskText', () => {
  it('leaves an unknown placeholder as it is', () => {
    expect(unmaskText('⟦1⟧ ⟦9⟧', ['x'])).toBe('x ⟦9⟧');
  });
});
