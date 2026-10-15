import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './markdown';
import { isExternal, safeHref } from './safe-href';

const render = (source: string) =>
  renderToStaticMarkup(<Markdown>{source}</Markdown>);

describe('safeHref', () => {
  test('follows http(s), mailto, in-app paths and fragments', () => {
    expect(safeHref('https://github.com/a/b/pull/1')).toBe(
      'https://github.com/a/b/pull/1',
    );
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('/projects/p1')).toBe('/projects/p1');
    expect(safeHref('#plan')).toBe('#plan');
  });

  test('drops script, data and protocol-relative targets', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref(' JavaScript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<b>x</b>')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('')).toBeNull();
    expect(safeHref(undefined)).toBeNull();
  });

  test('only off-app targets are external', () => {
    expect(isExternal('https://x.dev')).toBe(true);
    expect(isExternal('/fleet')).toBe(false);
  });
});

describe('Markdown', () => {
  test('raw HTML never becomes markup', () => {
    const html = render(
      'before <script>alert(1)</script> <img src=x onerror="alert(1)"> after',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  test('a javascript: link renders as plain text', () => {
    const html = render('[click](javascript:alert(1))');
    expect(html).not.toContain('href');
    expect(html).toContain('click');
  });

  test('bare URLs become external links', () => {
    const html = render('PR: https://github.com/a/b/pull/155 is green');
    expect(html).toContain('href="https://github.com/a/b/pull/155"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  test('inline code, lists and emphasis', () => {
    const html = render('Run `bun test`:\n\n- one\n- **two**\n\n1. first');
    expect(html).toContain('<code');
    expect(html).toContain('bun test');
    expect(html).toContain('<ul');
    expect(html).toContain('<ol');
    expect(html).toContain('<strong>two</strong>');
  });

  test('headings are demoted below the page h1', () => {
    const html = render('# Plan\n\n## Steps');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<h2');
    expect(html).toContain('<h3');
    expect(html).toContain('<h4');
  });

  test('fenced code goes to CodeBlock with its text intact', () => {
    const html = render('```sh\nbun run check\n```');
    expect(html).toContain('bun run check');
    expect(html).not.toContain('language-sh');
  });

  test('GFM tables render as a table', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
  });

  test('empty source renders nothing', () => {
    expect(render('   ')).toBe('');
  });
});
