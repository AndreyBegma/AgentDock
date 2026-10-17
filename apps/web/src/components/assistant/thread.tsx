'use client';

import type {
  AssistantMessageView,
  AssistantToolStep,
} from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import {
  type ChatMessage,
  ChatThread,
} from '@andrewbehma/glass-ui/chat-thread';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import { useMemo } from 'react';
import type { TurnNotice } from '../../lib/assistant/notice';
import type { LiveTool, LiveTurn } from '../../lib/assistant/turn';
import { Markdown } from '../markdown/markdown';
import { ToolBlock } from './tool-block';

const LIVE_USER = 'live-user';
const LIVE_REPLY = 'live-reply';

interface Row {
  chat: ChatMessage;
  tools: (LiveTool | AssistantToolStep)[];
  streaming: boolean;
}

const stored = (message: AssistantMessageView): Row => ({
  chat: {
    id: message.id,
    author: message.role === 'user' ? 'You' : 'Assistant',
    body: message.displayContent || message.content,
    dateTime: message.createdAt,
  },
  tools: message.tools,
  streaming: false,
});

/** The stored messages, then the turn still streaming. */
export function rowsOf(
  messages: readonly AssistantMessageView[],
  live: LiveTurn | null,
): Row[] {
  const rows = messages.map(stored);
  if (live) {
    rows.push(
      {
        chat: { id: LIVE_USER, author: 'You', body: live.text },
        tools: [],
        streaming: false,
      },
      {
        chat: { id: LIVE_REPLY, author: 'Assistant', body: live.reply },
        tools: live.tools,
        streaming: true,
      },
    );
  }
  return rows;
}

/** The conversation: markdown replies, tool blocks, and the composer. */
export function Thread({
  messages,
  live,
  notice,
  projectId,
  onSend,
  disabledReason,
  onDismissNotice,
}: {
  messages: readonly AssistantMessageView[];
  live: LiveTurn | null;
  notice: TurnNotice | null;
  projectId: string | null;
  onSend: (text: string) => void;
  disabledReason?: string;
  onDismissNotice: () => void;
}) {
  const rows = useMemo(() => rowsOf(messages, live), [messages, live]);
  const byId = useMemo(
    () => new Map(rows.map((row) => [row.chat.id, row])),
    [rows],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <ChatThread
        className="min-h-0 flex-1"
        messages={rows.map((row) => row.chat)}
        empty={
          <p className="p-4 text-sm text-ink-3">
            Ask about the Board, the fleet or the queue — or have a card
            drafted.
          </p>
        }
        labels={{ log: 'Assistant conversation' }}
        renderBody={(message) => {
          const row = byId.get(message.id);
          const mine = message.author === 'You';
          return (
            <div className="flex flex-col gap-2">
              {row?.tools.map((tool) => (
                <ToolBlock key={tool.id} tool={tool} projectId={projectId} />
              ))}
              {mine ? (
                <p className="whitespace-pre-wrap">{message.body}</p>
              ) : message.body ? (
                <Markdown>{message.body}</Markdown>
              ) : row?.streaming ? (
                <Spinner size="sm" label="Thinking" />
              ) : null}
            </div>
          );
        }}
        composer={{
          onSubmit: onSend,
          multiline: true,
          placeholder: 'Message the assistant',
          'aria-label': 'Message the assistant',
          sendLabel: 'Send',
          disabled: live !== null || disabledReason !== undefined,
          disabledReason:
            live !== null ? 'The assistant is answering' : disabledReason,
        }}
      />
      {notice ? (
        <Banner
          tone={notice.tone === 'cap' ? 'warn' : 'danger'}
          title={notice.title}
          onDismiss={onDismissNotice}
        >
          {notice.text}
        </Banner>
      ) : null}
    </div>
  );
}
