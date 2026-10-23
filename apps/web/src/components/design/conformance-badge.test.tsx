import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConformanceBadge } from './conformance-badge';

const off = {
  ok: false,
  missing: ['breakdown'],
  extra: ['Notes'],
  misplaced: [],
};

const render = (
  conformance: Parameters<typeof ConformanceBadge>[0]['conformance'],
  over: Partial<Parameters<typeof ConformanceBadge>[0]> = {},
) =>
  renderToStaticMarkup(
    <ConformanceBadge
      conformance={conformance}
      canComplete
      completing={false}
      disabledReason={null}
      onComplete={() => {}}
      {...over}
    />,
  );

describe('ConformanceBadge (#833 D11)', () => {
  test('no badge for a legacy revision or a conforming one', () => {
    expect(render(null)).toBe('');
    expect(render({ ok: true, missing: [], extra: [], misplaced: [] })).toBe(
      '',
    );
  });

  test('names the differences and offers Complete', () => {
    const html = render(off);
    expect(html).toContain('Not per template');
    expect(html).toContain('Missing');
    expect(html).toContain('breakdown');
    expect(html).toContain('Extra');
    expect(html).toContain('Complete');
    expect(html).not.toContain('disabled=""');
  });

  test('Complete is off with its reason, and gone for a reader', () => {
    expect(
      render(off, { disabledReason: 'A design turn is running.' }),
    ).toContain('disabled=""');
    expect(render(off, { canComplete: false })).not.toContain('Complete');
  });

  test('too_many_steps suggests splitting into a stack', () => {
    const html = render({
      ...off,
      missing: [],
      extra: [],
      reason: 'too_many_steps',
    });
    expect(html).toContain('splitting the card into a stack');
  });
});
