import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunKindBlock } from './token-saver-section';

describe('RunKindBlock (#748)', () => {
  test('shows the manual session row with its priced saving and how it is priced', () => {
    const html = renderToStaticMarkup(
      <RunKindBlock
        rows={[
          {
            runKind: 'manual',
            estimateUsd: 0.42,
            estimateTokens: 90_000,
            commands: 12,
          },
        ]}
      />,
    );
    expect(html).toContain('Manual session');
    expect(html).toContain('$0.42');
    expect(html).toContain('s own model and turns');
  });

  test('no pricing hint without a manual row', () => {
    const html = renderToStaticMarkup(
      <RunKindBlock
        rows={[
          {
            runKind: 'card',
            estimateUsd: 0.1,
            estimateTokens: 1000,
            commands: 3,
          },
        ]}
      />,
    );
    expect(html).toContain('Card worker');
    expect(html).not.toContain('own model');
  });

  test('renders nothing for no rows', () => {
    expect(renderToStaticMarkup(<RunKindBlock rows={[]} />)).toBe('');
  });
});
