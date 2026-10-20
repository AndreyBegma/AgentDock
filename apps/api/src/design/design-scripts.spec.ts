import {
  injectPinHelper,
  type PlannerParseResult,
  parsePlannerOutput,
} from '@nautelle/shared';
import { checkMockupScripts, withMockupScriptCheck } from './design-scripts';

const page = (body: string) =>
  `<!doctype html><html lang="en"><body>${body}</body></html>`;

describe('checkMockupScripts', () => {
  it('passes a frame without scripts', () => {
    expect(checkMockupScripts(page('<p>Board</p>'))).toBeNull();
  });

  it('passes valid scripts, an IIFE that names top, and the pin helper', () => {
    const html = page(
      [
        '<script>(() => { const top = document.querySelector("header"); top.hidden = false; })();</script>',
        '<script type="text/javascript">"use strict"; let count = 0; function name2() { const self = 1; return self; }</script>',
        '<script>{ let top = 1; }</script>',
      ].join(''),
    );
    expect(checkMockupScripts(html)).toBeNull();
    expect(checkMockupScripts(injectPinHelper(html))).toBeNull();
  });

  it('skips module, data and src scripts', () => {
    const html = page(
      [
        '<script type="module">import x from "https://unpkg.com/x@1.0.0"; const top = x;</script>',
        '<script type="application/json">{"a": 1}</script>',
        '<script type="text/template"><div>{{ not js</div></script>',
        '<script src="https://unpkg.com/x@1.0.0/x.js"></script>',
      ].join(''),
    );
    expect(checkMockupScripts(html)).toBeNull();
  });

  it.each(['const', 'let'])('fails a top-level %s top', (kind) => {
    expect(
      checkMockupScripts(page(`<script>${kind} top = 1;</script>`)),
    ).toMatch(
      /the 1st inline script declares a top-level "top".*Identifier 'top' has already been declared.*IIFE/,
    );
  });

  it('fails a top-level class named after a window global', () => {
    expect(
      checkMockupScripts(
        page(
          '<script>(() => {})();</script><script>class location {}</script>',
        ),
      ),
    ).toMatch(/the 2nd inline script declares a top-level "location"/);
  });

  it('fails a script that does not parse, quoting the parser', () => {
    expect(checkMockupScripts(page('<script>\nrender(;\n</script>'))).toBe(
      `the 1st inline script does not parse: "SyntaxError: Unexpected token ';' (line 2)"`,
    );
  });
});

describe('withMockupScriptCheck', () => {
  const result = (frames: string[], blocks: string[], kept?: string[]) =>
    [
      '```agentdock-plan',
      JSON.stringify({
        action: 'design',
        taskKey: 't1',
        variant: 1,
        frames,
        ...(kept ? { kept } : {}),
        title: 'Board',
        rationale: 'Why',
        addressed: [],
      }),
      '```',
      ...blocks.flatMap((html) => ['````agentdock-design', html, '````']),
    ].join('\n');

  const parse = (
    text: string,
    previousFrames?: { name: string; html: string }[],
  ): PlannerParseResult<'design'> =>
    withMockupScriptCheck(
      parsePlannerOutput(text, 'design', {
        taskKey: 't1',
        variant: 1,
        openCommentIds: [],
        previousFrames,
      }),
    );

  it('fails the turn and names the frame', () => {
    const parsed = parse(
      result(
        ['Board page', 'Card tile'],
        [page('<p>ok</p>'), page('<script>const top = 1;</script>')],
      ),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.reason).toBe('design_script_invalid');
    expect(parsed.error.message).toMatch(
      /^frame "Card tile": the 1st inline script/,
    );
  });

  it('passes valid frames unchanged', () => {
    const text = result(
      ['Board page'],
      [page('<script>(() => {})();</script>')],
    );
    const parsed = parse(text);
    expect(parsed).toEqual(
      parsePlannerOutput(text, 'design', {
        taskKey: 't1',
        variant: 1,
        openCommentIds: [],
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it('does not check a kept frame again', () => {
    const parsed = parse(
      result(['Board page', 'Card tile'], [page('<p>new</p>')], ['Card tile']),
      [
        { name: 'Board page', html: page('<p>old</p>') },
        { name: 'Card tile', html: page('<script>const top = 1;</script>') },
      ],
    );
    expect(parsed.ok).toBe(true);
  });
});
