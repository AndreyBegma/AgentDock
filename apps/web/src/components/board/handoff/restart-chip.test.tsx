import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RestartChip } from './restart-chip';

const html = (
  restartMode: 'resume' | 'fresh' | 'first' | null,
  warmupSavedUsd: string | null = null,
) =>
  renderToStaticMarkup(<RestartChip card={{ restartMode, warmupSavedUsd }} />);

test('a fresh start names the saving', () => {
  expect(html('fresh', '0.42')).toContain(
    'resumed from handoff · saved ≈ $0.42',
  );
});

test('a fresh start without a saving drops the amount', () => {
  const out = html('fresh', null);
  expect(out).toContain('resumed from handoff');
  expect(out).not.toContain('saved');
});

test('--resume reads resumed session', () => {
  expect(html('resume')).toContain('resumed session');
});

test('a first round or no round shows no chip', () => {
  expect(html('first')).toBe('');
  expect(html(null)).toBe('');
});
