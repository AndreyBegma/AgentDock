/** Words too common in card text to say two cards are alike. */
const STOP_WORDS = new Set(
  'a an and are as at be by for from has have in into is it its of on or that the this to was we were when with without should must can add make show use card cards'.split(
    ' ',
  ),
);

/** The distinct words of a text, lowercased, without stop words or one letter. */
export const wordsOf = (text: string): Set<string> =>
  new Set(
    text
      .normalize('NFKC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w)),
  );

/**
 * How alike two cards read, 0–1: the overlap of their title words, weighted
 * double, and of their body words. Only a first cut — the model decides what
 * is a duplicate; this keeps what it is shown short.
 */
export const similarity = (
  a: { title: string; body: string },
  b: { title: string; body: string },
): number => {
  const jaccard = (x: Set<string>, y: Set<string>) => {
    if (x.size === 0 || y.size === 0) return 0;
    let shared = 0;
    for (const w of x) if (y.has(w)) shared++;
    return shared / (x.size + y.size - shared);
  };
  const title = jaccard(wordsOf(a.title), wordsOf(b.title));
  const all = jaccard(
    wordsOf(`${a.title} ${a.body}`),
    wordsOf(`${b.title} ${b.body}`),
  );
  return (2 * title + all) / 3;
};

/**
 * The open cards most like `card`, best first, at most `max`; a card sharing
 * no word with it is never one.
 */
export const likelyDuplicates = <C extends { title: string; body: string }>(
  card: { title: string; body: string },
  open: readonly C[],
  max: number,
): C[] =>
  open
    .map((other) => ({ other, score: similarity(card, other) }))
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, max)
    .map((s) => s.other);
