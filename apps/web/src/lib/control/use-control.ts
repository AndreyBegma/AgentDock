'use client';

import {
  COMMAND_RUN_LIVE_EVENT,
  type CommandRunView,
  type OrchestratorStartRequest,
} from '@agentdock/shared';
import { toast } from 'glass-ui/toast';
import { useCallback, useRef, useState } from 'react';
import { api } from '../api';
import { useLive } from '../live/use-live';
import { describeControlError, describeOutcome, type Outcome } from './format';
import {
  applyRunEvent,
  isPending,
  NO_PENDING_RUNS,
  type PendingRuns,
  parseRunEvent,
} from './pending';

type Command = CommandRunView['command'];

const keyOf = (command: Command, slot?: string | null) =>
  `${command}|${slot ?? ''}`;

const show = ({ tone, text }: Outcome) => {
  if (tone === 'success') toast.success(text);
  else if (tone === 'error') toast.error(text);
  else toast(text);
};

/**
 * Sends the control commands of one project and tracks which are pending.
 *
 * The POSTs are synchronous (spec 17 note 17): the actor's toast comes from the
 * response. `command_run.updated` frames feed the pending list for everybody on
 * the project, and a run that finishes while this tab has no request of its own
 * in flight for it (somebody else's) is announced from the frame.
 */
export function useControl(projectId: string) {
  const [pending, setPending] = useState<PendingRuns>(NO_PENDING_RUNS);
  const [inFlight, setInFlight] = useState<readonly string[]>([]);
  const own = useRef<string[]>([]);

  useLive(`project:${projectId}`, (message) => {
    if (message.event !== COMMAND_RUN_LIVE_EVENT) return;
    const run = parseRunEvent(message.data);
    if (!run) return;
    setPending((current) => applyRunEvent(current, run));
    if (run.status === 'requested') return;
    if (own.current.includes(keyOf(run.command, run.slot))) return;
    const outcome = describeOutcome(run);
    if (!outcome) return;
    const who = run.user?.email ? `${run.user.email}: ` : '';
    show({ ...outcome, text: `${who}${outcome.text}` });
  });

  const post = useCallback(
    async (
      command: Command,
      path: string,
      body: unknown,
      slot?: string,
    ): Promise<CommandRunView | undefined> => {
      const key = keyOf(command, slot);
      own.current = [...own.current, key];
      setInFlight(own.current);
      try {
        const run = await api<CommandRunView>(`/projects/${projectId}${path}`, {
          method: 'POST',
          body,
        });
        const outcome = describeOutcome(run);
        if (outcome) show(outcome);
        return run;
      } catch (err) {
        toast.error(describeControlError(err));
        return undefined;
      } finally {
        const at = own.current.indexOf(key);
        own.current = own.current.filter((_, i) => i !== at);
        setInFlight(own.current);
      }
    },
    [projectId],
  );

  return {
    pending,
    /** True while a run of `command` (on `slot`) is in flight or pending. */
    busy: (command: Command, slot?: string) =>
      inFlight.includes(keyOf(command, slot)) ||
      isPending(pending, command, slot),
    start: (request: OrchestratorStartRequest) =>
      post('orchestrator.start', '/orchestrator/start', request),
    stop: () => post('orchestrator.stop', '/orchestrator/stop', {}),
    stopSlot: (slot: string) =>
      post('slot.stop', `/slots/${encodeURIComponent(slot)}/stop`, {}, slot),
    message: (slot: string, text: string) =>
      post(
        'slot.message',
        `/slots/${encodeURIComponent(slot)}/message`,
        { text },
        slot,
      ),
  };
}
