import type { LlmErrorCode, LlmProviderId } from '../llm';

/** The assistant (ADR-0060): personal conversations over the LLM gateway. */

export const ASSISTANT_MESSAGE_ROLES = ['user', 'assistant'] as const;
export type AssistantMessageRole = (typeof ASSISTANT_MESSAGE_ROLES)[number];

export const ASSISTANT_ATTACHMENT_KINDS = ['card', 'session', 'file'] as const;
export type AssistantAttachmentKind =
  (typeof ASSISTANT_ATTACHMENT_KINDS)[number];

/** Characters of one message a person sends. */
export const ASSISTANT_MESSAGE_MAX = 16_000;
/** Characters of a conversation title. */
export const ASSISTANT_TITLE_MAX = 120;
/** Attachments one conversation holds. */
export const ASSISTANT_ATTACHMENTS_MAX = 20;

/** Codes of the assistant's own refusals; the gateway's are `LlmErrorCode`. */
export const ASSISTANT_ERROR = {
  notFound: 'not_found',
  /** The person's role on the project is too low for this. */
  forbidden: 'forbidden',
  /** The model is not one of the enabled models. */
  modelNotEnabled: 'assistant_model_not_enabled',
  /** No model is picked and the instance has no default. */
  noModel: 'assistant_no_model',
  /** ADR-0021: the session's project keeps its content on the machine. */
  sessionContentOff: 'session_content_off',
  /** A file needs the conversation's project: its quota holds the bytes. */
  projectRequired: 'project_required',
  tooManyAttachments: 'too_many_attachments',
  /** The turn failed for a reason that is not the gateway's. */
  failed: 'assistant_failed',
} as const;
export type AssistantErrorCode =
  (typeof ASSISTANT_ERROR)[keyof typeof ASSISTANT_ERROR];

/** One model the person can pick. */
export interface AssistantModelOption {
  provider: LlmProviderId;
  model: string;
  /** The instance default (`PUT /admin/llm/default-model`). */
  isDefault: boolean;
  /** Images attached are sent to it. */
  vision: boolean;
}

/** `GET /assistant/models`. */
export interface AssistantModelsView {
  models: AssistantModelOption[];
}

export interface AssistantConversationView {
  id: string;
  /** Null is Auto. */
  projectId: string | null;
  projectName: string | null;
  title: string | null;
  /** Null is the instance default. */
  provider: LlmProviderId | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantAttachmentView {
  id: string;
  kind: AssistantAttachmentKind;
  label: string;
  /** Null while pending: the next message sent takes it. */
  messageId: string | null;
  projectId: string | null;
  /** `card`: its number on the project's Board. */
  cardNumber: number | null;
  sessionId: string | null;
  /** `file`: the stored attachment, its type and size. */
  attachmentId: string | null;
  mime: string | null;
  size: number | null;
  createdAt: string;
}

/** One tool step of a reply, as stored and as streamed. */
export interface AssistantToolStep {
  id: string;
  name: string;
  ok: boolean;
  /** One line for the step's row, e.g. `Read queue — 14 ready`. */
  summary: string;
  /** `draft_card`: the draft shown with Edit and Queue; nothing is stored. */
  draft?: AssistantCardDraft;
}

/** A card the assistant drafted; `queue_card` puts it on the Board. */
export interface AssistantCardDraft {
  projectId: string;
  title: string;
  body: string;
  kind: string | null;
}

export interface AssistantMessageView {
  id: string;
  role: AssistantMessageRole;
  /** English, canonical: model context and search. */
  content: string;
  /** What a reopened conversation shows: the person's language. */
  displayContent: string;
  language: string;
  tools: AssistantToolStep[];
  provider: LlmProviderId | null;
  model: string | null;
  attachments: AssistantAttachmentView[];
  createdAt: string;
}

/** `POST /assistant/conversations`. Omitted fields are Auto and the default model. */
export interface CreateAssistantConversationRequest {
  projectId?: string | null;
  provider?: LlmProviderId | null;
  model?: string | null;
}

/** `PATCH /assistant/conversations/:id`. `null` returns to Auto / the default. */
export interface UpdateAssistantConversationRequest {
  title?: string;
  projectId?: string | null;
  provider?: LlmProviderId | null;
  model?: string | null;
}

/** `POST /assistant/conversations/:id/attachments` (files go to `…/attachments/files`). */
export type AddAssistantAttachmentRequest =
  | { kind: 'card'; projectId: string; cardNumber: number }
  | { kind: 'session'; sessionId: string };

/** `POST /assistant/conversations/:id/stream`. */
export interface AssistantStreamRequest {
  message: string;
}

/**
 * What the stream sends, one `data:` line of JSON each: text as it arrives,
 * tool progress, the project once resolved, the title once written, then
 * exactly one of `done` or `error`.
 */
export type AssistantStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name: string; status: 'started' }
  | ({ type: 'tool'; status: 'done' } & AssistantToolStep)
  | { type: 'project'; projectId: string; projectName: string }
  | { type: 'title'; title: string }
  | {
      type: 'done';
      userMessage: AssistantMessageView;
      message: AssistantMessageView;
    }
  | {
      type: 'error';
      code: LlmErrorCode | AssistantErrorCode;
      message: string;
      provider?: LlmProviderId;
      resetsAt?: string;
    };
