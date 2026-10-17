import { describe, expect, test } from 'bun:test';
import type { PlanCandidateView } from '@agentdock/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { plan } from '../../lib/planner/fixtures';
import { CandidateGroup } from './candidate-group';

const candidate = (
  id: string,
  over: Partial<PlanCandidateView> = {},
): PlanCandidateView => ({
  id,
  planId: 'plan-1',
  position: 0,
  title: `Card ${id}`,
  kind: 'feature',
  body: '## Summary\nA daily rollup table.',
  stage: null,
  status: 'pending',
  version: 1,
  card: null,
  attachments: 0,
  ...over,
});

const render = (candidates: PlanCandidateView[], stack = false) =>
  renderToStaticMarkup(
    <CandidateGroup
      plan={plan({
        mode: 'card',
        status: 'reviewing',
        title: 'Webhook reliability',
        tasks: [],
        intake: {
          roundsAsked: 1,
          maxRounds: 4,
          candidates,
          candidateStack: stack
            ? { title: 'Webhooks', body: '', design: false, stages: ['A', 'B'] }
            : null,
        },
      })}
      selected={new Set(['b'])}
      busy={false}
      onToggle={() => {}}
      onOpen={() => {}}
      onAccept={() => {}}
      onReject={() => {}}
      onAcceptAll={() => {}}
      onOpenCard={() => {}}
    />,
  );

describe('CandidateGroup (#592)', () => {
  test('a pending row offers Open, Reject and Accept, its excerpt, and a checkbox', () => {
    const html = render([candidate('a'), candidate('b', { kind: 'bug' })]);
    expect(html).toContain('Webhook reliability');
    expect(html).toContain('Proposed split · 2 cards');
    expect(html).toContain('Accept all');
    expect(html).toContain('A daily rollup table.');
    expect(html).toContain('aria-label="Select Card a"');
    for (const verb of ['Open', 'Reject', 'Accept']) {
      expect(html).toContain(`>${verb}</button>`);
    }
  });

  test('decided rows say what became of them; a stack numbers its stages', () => {
    const html = render(
      [
        candidate('a', {
          stage: 0,
          status: 'accepted',
          attachments: 1,
          card: { number: 241, label: 'C-241' },
        }),
        candidate('b', { stage: 1, status: 'rejected' }),
        candidate('c', { stage: 1 }),
      ],
      true,
    );
    expect(html).toContain('Proposed stack · 2 of 3 decided');
    expect(html).toContain('Accept rest');
    expect(html).toContain('C-241');
    expect(html).toContain('took the attachments');
    expect(html).toContain('Rejected · no card made');
    expect(html).toContain('title="Stage 2"');
  });
});
