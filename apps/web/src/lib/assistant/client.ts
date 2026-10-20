import {
  type AddAssistantAttachmentRequest,
  type AssistantAttachmentView,
  type AssistantConversationView,
  type AssistantMessageView,
  type AssistantModelsView,
  type AssistantStreamEvent,
  ATTACHMENT_UPLOAD_FIELD,
  type CreateAssistantConversationRequest,
  type UpdateAssistantConversationRequest,
} from '@nautelle/shared';
import { ApiError, api, csrfHeaders } from '../api';
import { parseSse } from './sse';

const base = '/assistant';
const conversationPath = (id: string) =>
  `${base}/conversations/${encodeURIComponent(id)}`;

export const assistantApi = {
  models: () => api<AssistantModelsView>(`${base}/models`),
  conversations: () =>
    api<AssistantConversationView[]>(`${base}/conversations`),
  create: (body: CreateAssistantConversationRequest) =>
    api<AssistantConversationView>(`${base}/conversations`, {
      method: 'POST',
      body,
    }),
  get: (id: string) => api<AssistantConversationView>(conversationPath(id)),
  update: (id: string, body: UpdateAssistantConversationRequest) =>
    api<AssistantConversationView>(conversationPath(id), {
      method: 'PATCH',
      body,
    }),
  remove: (id: string) => api(conversationPath(id), { method: 'DELETE' }),
  messages: (id: string) =>
    api<AssistantMessageView[]>(`${conversationPath(id)}/messages`),
  attachments: (id: string) =>
    api<AssistantAttachmentView[]>(`${conversationPath(id)}/attachments`),
  attach: (id: string, body: AddAssistantAttachmentRequest) =>
    api<AssistantAttachmentView>(`${conversationPath(id)}/attachments`, {
      method: 'POST',
      body,
    }),
  detach: (id: string, attachmentId: string) =>
    api(
      `${conversationPath(id)}/attachments/${encodeURIComponent(attachmentId)}`,
      {
        method: 'DELETE',
      },
    ),
};

async function failure(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string | string[];
  } | null;
  const message = Array.isArray(body?.message)
    ? body.message.join('; ')
    : (body?.message ?? response.statusText);
  return new ApiError(
    response.status,
    undefined,
    message,
    undefined,
    body as Record<string, unknown> | null,
  );
}

/** `POST …/attachments/files`: multipart, one file. */
export async function attachFile(
  id: string,
  file: File,
): Promise<AssistantAttachmentView> {
  const form = new FormData();
  form.append(ATTACHMENT_UPLOAD_FIELD, file);
  const response = await fetch(
    `/api${conversationPath(id)}/attachments/files`,
    {
      method: 'POST',
      headers: csrfHeaders(),
      body: form,
    },
  );
  if (!response.ok) throw await failure(response);
  return (await response.json()) as AssistantAttachmentView;
}

/**
 * One turn as it streams: the events in order, until `done` or `error` (or
 * until `signal` aborts). A refusal before the stream opens (a 404, the
 * throttle) throws; one after it arrives as an `error` event.
 */
export async function* streamTurn(
  id: string,
  message: string,
  signal: AbortSignal,
): AsyncGenerator<AssistantStreamEvent> {
  const response = await fetch(`/api${conversationPath(id)}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ message }),
    signal,
  });
  if (!response.ok || !response.body) throw await failure(response);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const parsed = parseSse(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) yield event;
    }
    // A last event the server did not terminate with a blank line.
    for (const event of parseSse(`${buffer}\n\n`).events) yield event;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
