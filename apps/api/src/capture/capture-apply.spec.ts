import {
  CAPTURE_EVIDENCE_EXCERPT_MAX,
  type CaptureSuggestion,
  captureFingerprint,
} from '@nautelle/shared';
import {
  type DedupeCard,
  type DedupeDismissal,
  evidenceExcerpts,
  knownFingerprints,
  planCaptureApply,
} from './capture-apply';

const NOW = new Date('2026-10-15T12:00:00Z');
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const suggestion = (
  title: string,
  extra: Partial<CaptureSuggestion> = {},
): CaptureSuggestion => ({
  title,
  body: '',
  kind: 'bug',
  why: 'Said to do it later.',
  confidence: 0.9,
  evidence: ['1'],
  ...extra,
});

const card = (
  title: string,
  column: DedupeCard['column'],
  completedAt: Date | null = null,
): DedupeCard => ({ title, fingerprint: null, column, completedAt });

const titles = (cards: { title: string }[]) => cards.map((c) => c.title);

describe('card capture dedupe (D6)', () => {
  const plan = (
    suggestions: CaptureSuggestion[],
    cards: DedupeCard[] = [],
    dismissals: DedupeDismissal[] = [],
    room = 30,
  ) =>
    planCaptureApply(
      suggestions,
      knownFingerprints(cards, dismissals, NOW),
      room,
    );

  it('drops a title matching an open card, however it is written', () => {
    const result = plan(
      [suggestion('Fix the login redirect loop!'), suggestion('Add dark mode')],
      [card('fix  the Login redirect-loop', 'todo')],
    );
    expect(titles(result.kept)).toEqual(['Add dark mode']);
    expect(result.dropped).toEqual([
      {
        fingerprint: captureFingerprint('Fix the login redirect loop'),
        reason: 'known',
      },
    ]);
  });

  it('drops a title already in the Inbox or in progress', () => {
    const result = plan(
      [suggestion('A'), suggestion('B'), suggestion('C')],
      [card('A', 'inbox'), card('B', 'in_progress')],
    );
    expect(titles(result.kept)).toEqual(['C']);
  });

  it('drops a card completed within 30 days, not one completed before', () => {
    const result = plan(
      [suggestion('Recent work'), suggestion('Old work')],
      [
        card('Recent work', 'completed', daysAgo(29)),
        card('Old work', 'completed', daysAgo(31)),
      ],
    );
    expect(titles(result.kept)).toEqual(['Old work']);
  });

  it('drops a dismissal within 90 days, not one before', () => {
    const result = plan(
      [suggestion('Dismissed lately'), suggestion('Dismissed long ago')],
      [],
      [
        {
          fingerprint: captureFingerprint('Dismissed lately'),
          createdAt: daysAgo(89),
        },
        {
          fingerprint: captureFingerprint('Dismissed long ago'),
          createdAt: daysAgo(91),
        },
      ],
    );
    expect(titles(result.kept)).toEqual(['Dismissed long ago']);
  });

  it('drops confidence 0.5 and keeps 0.6', () => {
    const result = plan([
      suggestion('Unsure', { confidence: 0.5 }),
      suggestion('Sure enough', { confidence: 0.6 }),
    ]);
    expect(titles(result.kept)).toEqual(['Sure enough']);
    expect(result.dropped).toEqual([
      { fingerprint: captureFingerprint('Unsure'), reason: 'low_confidence' },
    ]);
  });

  it('collapses duplicates of one result to the most confident', () => {
    const result = plan([
      suggestion('Fix CI', { confidence: 0.7, why: 'first' }),
      suggestion('fix ci.', { confidence: 0.95, why: 'second' }),
    ]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].why).toBe('second');
  });

  it('a stored fingerprint wins over the title', () => {
    const known = knownFingerprints(
      [
        {
          title: 'Renamed since',
          fingerprint: captureFingerprint('Original title'),
          column: 'todo',
          completedAt: null,
        },
      ],
      [],
      NOW,
    );
    expect(known.has(captureFingerprint('Original title'))).toBe(true);
  });

  it('keeps no more than the Inbox has room for', () => {
    const result = plan(
      [suggestion('One'), suggestion('Two'), suggestion('Three')],
      [],
      [],
      2,
    );
    expect(titles(result.kept)).toEqual(['One', 'Two']);
    expect(titles(result.overflow)).toEqual(['Three']);
  });
});

describe('evidence excerpts (D8)', () => {
  it('keeps a prompt head and a response tail, 300 characters at most', () => {
    const long = `${'a'.repeat(400)}END`;
    const sources = new Map([
      ['1', { kind: 'prompt', text: `START${'b'.repeat(400)}` }],
      ['2', { kind: 'response', text: long }],
      ['3', { kind: 'tool_output', text: 'never' }],
    ]);
    const evidence = evidenceExcerpts(['1', '2', '3', '9'], sources);
    expect(evidence.map((e) => e.contentId)).toEqual(['1', '2']);
    expect(evidence[0].excerpt.startsWith('START')).toBe(true);
    expect(evidence[1].excerpt.endsWith('END')).toBe(true);
    for (const e of evidence) {
      expect(e.excerpt.length).toBe(CAPTURE_EVIDENCE_EXCERPT_MAX);
    }
  });
});
