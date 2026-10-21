import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EscalationRow } from './card-sheet';

describe('Card sheet escalation row (#750 D9, D10)', () => {
  const escalation = {
    reason: 'misclassified' as const,
    note: 'The card needs a migration.',
    at: '2026-10-21T12:00:00.000Z',
  };
  const row = (model: string | null) =>
    renderToStaticMarkup(
      <EscalationRow card={{ model }} escalation={escalation} />,
    );

  test('a relaunched card records the escalation with its note', () => {
    const html = row(null);
    expect(html).toContain('Escalated to Opus · misclassified');
    expect(html).toContain('The card needs a migration.');
    expect(html).not.toContain('asks for Opus');
  });

  test("over a person's sonnet override the worker's ask is shown instead", () => {
    const html = row('sonnet');
    expect(html).toContain('The worker asks for Opus: misclassified');
    expect(html).toContain('The card needs a migration.');
    expect(html).not.toContain('Escalated to Opus');
  });
});
