'use client';

import type {
  AssistantAttachmentView,
  AssistantConversationView,
  AssistantMessageView,
  AssistantModelOption,
  LlmProviderId,
} from '@nautelle/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, describeError } from '../api';
import { assistantApi, attachFile, streamTurn } from './client';
import { noticeFor, type TurnNotice } from './notice';
import { applyEvent, type LiveTurn, startTurn } from './turn';

export interface Choice {
  projectId: string | null;
  provider: LlmProviderId | null;
  model: string | null;
}

const AUTO: Choice = { projectId: null, provider: null, model: null };

/** The assistant's state for one signed-in person: rail, thread, composer. */
export function useAssistant(enabled: boolean) {
  const [conversations, setConversations] = useState<
    AssistantConversationView[] | null
  >(null);
  const [models, setModels] = useState<AssistantModelOption[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessageView[]>([]);
  const [attachments, setAttachments] = useState<AssistantAttachmentView[]>([]);
  // The pickers of a conversation that does not exist yet.
  const [draftChoice, setDraftChoice] = useState<Choice>(AUTO);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [notice, setNotice] = useState<TurnNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // The conversation the thread shows; a late response for another is dropped.
  const current = useRef<string | null>(null);
  current.current = activeId;

  const active = conversations?.find((each) => each.id === activeId) ?? null;
  const choice: Choice = active
    ? {
        projectId: active.projectId,
        provider: active.provider,
        model: active.model,
      }
    : draftChoice;

  const refreshList = useCallback(async () => {
    try {
      setConversations(await assistantApi.conversations());
    } catch (cause) {
      setError(describeError(cause));
      setConversations((was) => was ?? []);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refreshList();
    assistantApi.models().then(
      (view) => setModels(view.models),
      () => setModels([]),
    );
  }, [enabled, refreshList]);

  const patch = useCallback((view: AssistantConversationView) => {
    setConversations((list) =>
      list ? list.map((each) => (each.id === view.id ? view : each)) : list,
    );
  }, []);

  const load = useCallback(async (id: string) => {
    try {
      const [loaded, files] = await Promise.all([
        assistantApi.messages(id),
        assistantApi.attachments(id),
      ]);
      if (current.current !== id) return;
      setMessages(loaded);
      setAttachments(files.filter((each) => each.messageId === null));
    } catch (cause) {
      if (current.current === id) setError(describeError(cause));
    }
  }, []);

  const reset = useCallback(() => {
    abort.current?.abort();
    setLive(null);
    setNotice(null);
    setError(null);
    setMessages([]);
    setAttachments([]);
  }, []);

  const select = useCallback(
    (id: string | null) => {
      reset();
      setActiveId(id);
      current.current = id;
      if (id) void load(id);
    },
    [load, reset],
  );

  /** The conversation to write to; the first message or attachment makes it. */
  const ensure = useCallback(async (): Promise<string> => {
    if (activeId) return activeId;
    const created = await assistantApi.create({
      projectId: draftChoice.projectId,
      provider: draftChoice.provider,
      model: draftChoice.model,
    });
    setConversations((list) => [created, ...(list ?? [])]);
    setActiveId(created.id);
    current.current = created.id;
    return created.id;
  }, [activeId, draftChoice]);

  const choose = useCallback(
    async (next: Partial<Choice>) => {
      if (!active) {
        setDraftChoice((was) => ({ ...was, ...next }));
        return;
      }
      try {
        patch(await assistantApi.update(active.id, next));
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [active, patch],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      try {
        patch(await assistantApi.update(id, { title }));
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [patch],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await assistantApi.remove(id);
        setConversations(
          (list) => list?.filter((each) => each.id !== id) ?? list,
        );
        if (current.current === id) select(null);
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [select],
  );

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || live) return;
      setNotice(null);
      setError(null);
      const controller = new AbortController();
      abort.current = controller;
      let id: string;
      try {
        id = await ensure();
      } catch (cause) {
        setError(describeError(cause));
        return;
      }
      let turn = startTurn(message);
      setLive(turn);
      try {
        for await (const event of streamTurn(id, message, controller.signal)) {
          if (current.current !== id) return;
          const outcome = applyEvent(turn, event);
          turn = outcome.turn;
          if (outcome.kind === 'streaming') {
            setLive(turn);
          } else if (outcome.kind === 'done') {
            setMessages((list) => [
              ...list,
              outcome.userMessage,
              outcome.message,
            ]);
            setAttachments([]);
            setLive(null);
          } else {
            // The notice says why there is no reply.
            setNotice(noticeFor(outcome.error));
            setLive(null);
          }
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        setLive(null);
        setError(
          cause instanceof ApiError
            ? describeError(cause)
            : 'The connection to the assistant was lost.',
        );
      } finally {
        if (current.current === id) setLive(null);
        // The title, the project and the order of the rail changed.
        void refreshList();
        if (current.current === id) void load(id);
      }
    },
    [ensure, live, load, refreshList],
  );

  const attach = useCallback(
    async (
      add: (id: string) => Promise<AssistantAttachmentView>,
    ): Promise<boolean> => {
      try {
        const id = await ensure();
        const created = await add(id);
        setAttachments((list) => [...list, created]);
        return true;
      } catch (cause) {
        setError(describeError(cause));
        return false;
      }
    },
    [ensure],
  );

  const attachCard = (projectId: string, cardNumber: number) =>
    attach((id) =>
      assistantApi.attach(id, { kind: 'card', projectId, cardNumber }),
    );
  const attachSession = (sessionId: string) =>
    attach((id) => assistantApi.attach(id, { kind: 'session', sessionId }));
  const uploadFile = (file: File) => attach((id) => attachFile(id, file));

  const detach = useCallback(
    async (attachmentId: string) => {
      if (!activeId) return;
      try {
        await assistantApi.detach(activeId, attachmentId);
        setAttachments((list) =>
          list.filter((each) => each.id !== attachmentId),
        );
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [activeId],
  );

  useEffect(() => () => abort.current?.abort(), []);

  return {
    conversations,
    models,
    active,
    choice,
    messages,
    attachments,
    live,
    notice,
    error,
    dismissError: () => setError(null),
    dismissNotice: () => setNotice(null),
    select,
    choose,
    rename,
    remove,
    send,
    attachCard,
    attachSession,
    uploadFile,
    detach,
  };
}
