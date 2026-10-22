import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

let taskKey = 'T1';
mock.module('next/navigation', () => ({
  useParams: () => ({ projectId: 'p1', planId: 'c2', taskKey }),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: DesignViewerPage } = await import('./page');

describe('the planner design page (C-165)', () => {
  test('a malformed task key shows Task not found instead of crashing', () => {
    taskKey = '%E0%A4%A';
    const html = renderToStaticMarkup(<DesignViewerPage />);
    expect(html).toContain('Task not found');
    expect(html).toContain('href="/projects/p1/planner/c2"');
  });
});
