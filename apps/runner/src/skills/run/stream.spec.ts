import { describe, expect, it } from 'bun:test';
import { finalResult, renderStreamLine, toolSummary } from './stream';

const line = (value: unknown) => JSON.stringify(value);

describe('renderStreamLine', () => {
  it('renders the session start, assistant text, tool calls and the result', () => {
    expect(
      renderStreamLine(
        line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }),
      ),
    ).toEqual([{ kind: 'system', text: 'session started · claude-opus-5-5' }]);
    expect(
      renderStreamLine(
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: '  Looking at the app.\n' },
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'bun test\nrm -rf x' },
              },
              { type: 'tool_use', name: 'TodoWrite', input: { todos: [] } },
              { type: 'thinking', thinking: 'secret thoughts' },
            ],
          },
        }),
      ),
    ).toEqual([
      { kind: 'assistant', text: 'Looking at the app.' },
      { kind: 'tool', text: 'Bash: bun test' },
      { kind: 'tool', text: 'TodoWrite' },
    ]);
    expect(
      renderStreamLine(
        line({ type: 'result', subtype: 'success', result: 'Done.' }),
      ),
    ).toEqual([{ kind: 'result', text: 'Done.' }]);
  });

  it('renders nothing for tool results, other system lines and garbage', () => {
    expect(
      renderStreamLine(line({ type: 'user', message: { content: [] } })),
    ).toEqual([]);
    expect(renderStreamLine(line({ type: 'system', subtype: 'hook' }))).toEqual(
      [],
    );
    expect(renderStreamLine('not json')).toEqual([]);
    expect(renderStreamLine('')).toEqual([]);
    expect(renderStreamLine('[1,2]')).toEqual([]);
  });

  it('masks secrets and caps lines', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const [rendered] = renderStreamLine(
      line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `token ${token}` }] },
      }),
    );
    expect(rendered?.text).toBe('token •••');
    const [long] = renderStreamLine(
      line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x'.repeat(9000) }] },
      }),
    );
    expect(long?.text.length).toBe(4000);
    expect(toolSummary('Read', { file_path: 'y'.repeat(500) }).length).toBe(
      200,
    );
  });
});

describe('finalResult', () => {
  it('takes the last result message', () => {
    const stream = [
      line({ type: 'result', subtype: 'success', result: 'first' }),
      line({ type: 'assistant', message: { content: [] } }),
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'last',
      }),
      '',
    ].join('\n');
    expect(finalResult(stream)).toEqual({ text: 'last', isError: false });
  });

  it('flags an error result, and answers null without one', () => {
    expect(
      finalResult(
        line({ type: 'result', subtype: 'error_max_turns', is_error: true }),
      ),
    ).toEqual({ text: null, isError: true });
    expect(finalResult(line({ type: 'assistant' }))).toBeNull();
  });
});
