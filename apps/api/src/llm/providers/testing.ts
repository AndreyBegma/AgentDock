import type { LlmStreamEvent } from '../types';

/** A `text/event-stream` response of the given events, split mid-line. */
export const sseResponse = (
  frames: readonly { event?: string; data: unknown }[],
  status = 200,
): Response => {
  const text = frames
    .map(
      (f) =>
        `${f.event ? `event: ${f.event}\n` : ''}data: ${
          typeof f.data === 'string' ? f.data : JSON.stringify(f.data)
        }\n\n`,
    )
    .join('');
  const bytes = new TextEncoder().encode(text);
  // Small chunks, so the parsers meet lines split across reads.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 17) {
        controller.enqueue(bytes.slice(i, i + 17));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
};

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const collect = async (
  stream: AsyncIterable<LlmStreamEvent>,
): Promise<LlmStreamEvent[]> => {
  const events: LlmStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

/** The URL, headers and JSON body of one mocked `fetch` call. */
export const requestOf = async (
  input: unknown,
  init: RequestInit | undefined,
): Promise<{
  url: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}> => {
  const request =
    input instanceof Request ? input : new Request(String(input), init);
  const headers = new Headers(init?.headers ?? request.headers);
  const raw =
    typeof init?.body === 'string' ? init.body : await request.clone().text();
  return {
    url: request.url,
    headers,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
  };
};
