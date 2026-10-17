import { BilingualSplitter, ENGLISH_MARKER, parseTrailer } from './bilingual';

const trailer = JSON.stringify({
  language: 'ru',
  reply: 'Two cards are ready.',
  message: 'What is in the queue?',
});

const feed = (chunks: string[]) => {
  const splitter = new BilingualSplitter();
  const streamed = chunks.map((c) => splitter.push(c));
  streamed.push(splitter.flush());
  return { splitter, streamed };
};

describe('BilingualSplitter', () => {
  it('streams the reply and holds the trailer back', () => {
    const { splitter, streamed } = feed([
      'Готовы ',
      'две карточки.',
      `\n${ENGLISH_MARKER}\n`,
      trailer,
    ]);
    expect(streamed.join('')).toBe('Готовы две карточки.\n');
    expect(splitter.reply).toBe('Готовы две карточки.');
    expect(splitter.trailer).toEqual({
      language: 'ru',
      reply: 'Two cards are ready.',
      message: 'What is in the queue?',
    });
  });

  it('never streams a marker split across chunks', () => {
    const text = `Привет${ENGLISH_MARKER}${trailer}`;
    const chunks = text.match(/[\s\S]{1,3}/g) ?? [];
    const { splitter, streamed } = feed(chunks);
    expect(streamed.join('')).toBe('Привет');
    expect(streamed.join('')).not.toContain('<');
    expect(splitter.trailer?.language).toBe('ru');
  });

  it('streams a held-back `<` that was not the marker', () => {
    const { splitter, streamed } = feed(['a <', '< b']);
    expect(streamed).toEqual(['a ', '<< b', '']);
    expect(splitter.reply).toBe('a << b');
    expect(splitter.trailer).toBeNull();
  });

  it('flushes a partial marker at the end of the call', () => {
    const { streamed } = feed(['done <<<agent']);
    expect(streamed.join('')).toBe('done <<<agent');
  });
});

describe('parseTrailer', () => {
  it('accepts a fenced trailer and normalises the language', () => {
    expect(
      parseTrailer(
        '```json\n{"language":"pt-BR","reply":" Hi ","message":"Oi"}\n```',
      ),
    ).toEqual({ language: 'pt', reply: 'Hi', message: 'Oi' });
  });

  it('refuses malformed trailers', () => {
    expect(parseTrailer('not json')).toBeNull();
    expect(
      parseTrailer('{"language":"Russian","reply":"","message":""}'),
    ).toBeNull();
    expect(parseTrailer('{"language":"ru","reply":1,"message":""}')).toBeNull();
  });
});
