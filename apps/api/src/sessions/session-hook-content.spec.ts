import { type HookEvent, parseHookEvent } from '@agentdock/shared/protocol';
import { contentDraftsOf, stripHookContent } from './session-hook-content';

const wire = (type: string, data: unknown) => ({
  v: 1 as const,
  seq: 1,
  ts: '2026-10-14T10:00:00.000Z',
  type,
  source: 'hook' as const,
  session: { runtime: 'claude', id: 's1' },
  data,
});

const parse = (type: string, data: unknown): HookEvent => {
  const result = parseHookEvent(wire(type, data));
  if (!result?.ok) throw new Error('fixture does not parse');
  return result.event;
};

const text = (value: string) => ({ text: value, truncated: false });

describe('contentDraftsOf', () => {
  it('maps a prompt to one prompt row', () => {
    const event = parse('hook.prompt_submitted', {
      chars: 5,
      content: { text: 'hello', truncated: true },
    });
    expect(contentDraftsOf(event)).toEqual([
      {
        kind: 'prompt',
        toolUseId: null,
        toolName: null,
        text: 'hello',
        truncated: true,
      },
    ]);
  });

  it('maps tool input and output with the tool use id and name', () => {
    const event = parse('hook.tool_finished', {
      toolUseId: 'tu_1',
      toolName: 'Bash',
      ok: true,
      input: text('ls'),
      output: text('a.txt'),
    });
    expect(contentDraftsOf(event)).toEqual([
      {
        kind: 'tool_input',
        toolUseId: 'tu_1',
        toolName: 'Bash',
        text: 'ls',
        truncated: false,
      },
      {
        kind: 'tool_output',
        toolUseId: 'tu_1',
        toolName: 'Bash',
        text: 'a.txt',
        truncated: false,
      },
    ]);
  });

  it('maps a stop response and ignores events without content', () => {
    const stopped = parse('hook.stopped', { response: text('done') });
    expect(contentDraftsOf(stopped).map((d) => d.kind)).toEqual(['response']);
    expect(contentDraftsOf(parse('hook.stopped', {}))).toEqual([]);
    expect(
      contentDraftsOf(parse('hook.permission_requested', { toolName: 'Bash' })),
    ).toEqual([]);
  });
});

describe('stripHookContent', () => {
  it('removes every content key and keeps the metadata', () => {
    const event = wire('hook.tool_finished', {
      toolUseId: 'tu_1',
      toolName: 'Bash',
      ok: true,
      input: text('secret'),
      output: text('secret'),
    });
    stripHookContent(event);
    expect(event.data).toEqual({
      toolUseId: 'tu_1',
      toolName: 'Bash',
      ok: true,
    });
  });

  it('strips an event that failed validation too', () => {
    const event = wire('hook.prompt_submitted', {
      chars: 'many',
      content: text('secret'),
    });
    stripHookContent(event);
    expect(JSON.stringify(event.data)).not.toContain('secret');
  });

  it('leaves other events alone', () => {
    const event = {
      ...wire('llm.request', { input: 1 }),
      source: 'otel' as const,
    };
    stripHookContent(event);
    expect(event.data).toEqual({ input: 1 });
  });
});
