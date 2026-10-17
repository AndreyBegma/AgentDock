'use client';

import type { PendingQuestion, SessionMessageRequest } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Input } from '@andrewbehma/glass-ui/field';
import { type FormEvent, useId, useState } from 'react';
import type { SendSessionMessage } from '../../lib/session-message/actions';
import {
  draftProblem,
  SESSION_MESSAGE_OUTCOME,
  sessionMessageError,
} from '../../lib/session-message/format';

type Result = { tone: 'ok' | 'warn' | 'danger'; text: string };

/**
 * #489: write to a running agent session without taking control of its
 * terminal — a line of text the agent reads at its next step (Claude Code
 * queues it while it works), and, while the session shows a question
 * selector, its options as buttons plus an "Other…" answer. Text only: the
 * API cleans it and the runner types it; no key ever goes through here.
 */
export function SessionMessageLine({
  send,
  question,
  label = 'Message the session',
  tone,
  inputId,
}: {
  send: SendSessionMessage;
  /** The selector the session shows now; null or absent when none is up. */
  question?: PendingQuestion | null;
  label?: string;
  /** `on-glass` inside a sheet or a glass panel. */
  tone?: 'surface' | 'on-glass';
  /** The text input's id, for a surrounding `Field`'s label. */
  inputId?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [other, setOther] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const submit = async (input: SessionMessageRequest, clear: () => void) => {
    setBusy(true);
    setResult(null);
    try {
      const { outcome } = await send(input);
      setResult(SESSION_MESSAGE_OUTCOME[outcome]);
      if (outcome === 'sent' || outcome === 'answered') clear();
    } catch (error) {
      setResult({ tone: 'danger', text: sessionMessageError(error) });
    } finally {
      setBusy(false);
    }
  };

  const sendText = (event: FormEvent) => {
    event.preventDefault();
    if (draftProblem(draft) !== null) return;
    void submit({ kind: 'text', text: draft }, () => setDraft(''));
  };

  const sendOther = (event: FormEvent) => {
    event.preventDefault();
    if (!question || other === null || draftProblem(other) !== null) return;
    void submit({ kind: 'other', questionKey: question.key, text: other }, () =>
      setOther(null),
    );
  };

  const problem = draftProblem(draft);

  return (
    <div className="flex flex-col gap-2">
      {question ? (
        <fieldset
          className="flex flex-col gap-2"
          aria-describedby={`${id}-question`}
        >
          <legend className="sr-only">The agent asks</legend>
          {question.header ? (
            <p className="text-xs text-ink-3">{question.header}</p>
          ) : null}
          <p id={`${id}-question`} className="whitespace-pre-line text-sm">
            {question.text}
          </p>
          <div className="flex flex-wrap gap-2">
            {question.options.map((option) => (
              <Button
                key={option.index}
                variant="glass"
                size="sm"
                disabled={busy}
                title={option.description}
                onClick={() =>
                  void submit(
                    {
                      kind: 'option',
                      questionKey: question.key,
                      index: option.index,
                    },
                    () => setOther(null),
                  )
                }
              >
                {option.index}. {option.label}
              </Button>
            ))}
            {question.other && other === null ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setOther('')}
              >
                Other…
              </Button>
            ) : null}
          </div>
          {question.other && other !== null ? (
            <form className="flex gap-2" onSubmit={sendOther}>
              <Input
                aria-label="Your own answer"
                tone={tone}
                className="min-w-0 flex-1"
                value={other}
                autoFocus
                onChange={(e) => setOther(e.target.value)}
              />
              <Button
                type="submit"
                variant="glass"
                size="sm"
                disabled={busy || draftProblem(other) !== null}
              >
                Answer
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setOther(null)}
              >
                Cancel
              </Button>
            </form>
          ) : null}
        </fieldset>
      ) : null}
      <form className="flex gap-2" onSubmit={sendText}>
        <Input
          id={inputId}
          aria-label={label}
          placeholder={
            question
              ? 'The agent waits on its question above'
              : `${label}… (queued while it works)`
          }
          tone={tone}
          className="min-w-0 flex-1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="submit"
          variant="glass"
          size="sm"
          disabled={busy || problem !== null}
        >
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </form>
      {problem === 'too_long' ? (
        <p role="alert" className="text-xs text-danger">
          Too long for one message.
        </p>
      ) : null}
      {result ? (
        <p
          role={result.tone === 'ok' ? 'status' : 'alert'}
          className={`text-xs ${
            result.tone === 'ok'
              ? 'text-ink-3'
              : result.tone === 'warn'
                ? 'text-warn'
                : 'text-danger'
          }`}
        >
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
