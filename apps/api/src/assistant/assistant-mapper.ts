import type {
  AssistantAttachmentView,
  AssistantConversationView,
  AssistantMessageView,
  AssistantToolStep,
} from '@agentdock/shared';
import type {
  AssistantAttachment,
  AssistantConversation,
  AssistantMessage,
  Attachment,
  BoardCard,
} from '@prisma/client';

export type ConversationRow = AssistantConversation & {
  project: { displayName: string } | null;
};

export type AttachmentRow = AssistantAttachment & {
  card: Pick<BoardCard, 'number' | 'projectId'> | null;
  attachment: Pick<Attachment, 'projectId' | 'mime' | 'size'> | null;
  session: { projectId: string | null } | null;
};

export type MessageRow = AssistantMessage & { attachments: AttachmentRow[] };

/** What an attachment query includes for `toAttachmentView`. */
export const ATTACHMENT_INCLUDE = {
  card: { select: { number: true, projectId: true } },
  attachment: { select: { projectId: true, mime: true, size: true } },
  session: { select: { projectId: true } },
} as const;

export const toConversationView = (
  row: ConversationRow,
): AssistantConversationView => ({
  id: row.id,
  projectId: row.projectId,
  projectName: row.project?.displayName ?? null,
  title: row.title,
  provider: row.provider,
  model: row.model,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toAttachmentView = (
  row: AttachmentRow,
): AssistantAttachmentView => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  messageId: row.messageId,
  projectId:
    row.card?.projectId ??
    row.attachment?.projectId ??
    row.session?.projectId ??
    null,
  cardNumber: row.card?.number ?? null,
  sessionId: row.sessionId,
  attachmentId: row.attachmentId,
  mime: row.attachment?.mime ?? null,
  size: row.attachment?.size ?? null,
  createdAt: row.createdAt.toISOString(),
});

const stepsOf = (value: unknown): AssistantToolStep[] =>
  Array.isArray(value) ? (value as AssistantToolStep[]) : [];

export const toMessageView = (row: MessageRow): AssistantMessageView => ({
  id: row.id,
  role: row.role,
  content: row.content,
  displayContent: row.displayContent,
  language: row.language,
  tools: stepsOf(row.toolResults),
  provider: row.provider,
  model: row.model,
  attachments: row.attachments.map(toAttachmentView),
  createdAt: row.createdAt.toISOString(),
});
