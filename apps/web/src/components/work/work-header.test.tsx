import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkHeader } from './work-header';

const render = (view: 'list' | 'board', title: 'Work' | 'Board') =>
  renderToStaticMarkup(
    <WorkHeader
      view={view}
      title={title}
      eyebrow="Project"
      onSelectList={() => {}}
      onSelectBoard={() => {}}
    />,
  );

describe('WorkHeader', () => {
  test('the project Board page is titled Board', () => {
    expect(render('board', 'Board')).toMatch(/<h1[^>]*>Board<\/h1>/);
  });

  test('the workspace page keeps the title Work', () => {
    expect(render('list', 'Work')).toMatch(/<h1[^>]*>Work<\/h1>/);
  });
});
