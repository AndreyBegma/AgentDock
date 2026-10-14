'use client';

import type {
  AdminRunnerDetail,
  AdminUser,
  UpdateRunnerSettingsRequest,
} from '@agentdock/shared';
import { Field, Select } from '@andrewbehma/glass-ui/field';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { describeRunnerError } from '../../../lib/runners/format';
import { localUserOptions } from '../../../lib/runners/local-settings';
import { useErrorToast } from '../../../lib/section/use-error-toast';

/**
 * The runner sheet's "Claude Code sessions" section (spec 201 D8, D17): the
 * user a local request from this machine acts as, and away mode, which sends a
 * permission prompt to the web app and Telegram instead of the terminal.
 * Admin only; the sheet is already an admin page.
 */
export function LocalSettings({
  runner,
  disabled,
  onChanged,
}: {
  runner: Pick<AdminRunnerDetail, 'id' | 'localUserId' | 'awayMode'>;
  /** A revoked runner cannot be reached, so nothing here is changed. */
  disabled: boolean;
  onChanged: () => void;
}) {
  const [users, setUsers] = useState<AdminUser[]>();
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  useEffect(() => {
    let cancelled = false;
    api<AdminUser[]>('/admin/users?status=approved')
      .then((list) => {
        if (!cancelled) setUsers(list);
      })
      .catch((err) => {
        if (!cancelled) showError(describeRunnerError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [showError]);

  const patch = async (body: UpdateRunnerSettingsRequest, saved: string) => {
    setBusy(true);
    try {
      await api(`/admin/runners/${runner.id}`, { method: 'PATCH', body });
      toast.success(saved);
      onChanged();
    } catch (err) {
      showError(describeRunnerError(err));
    } finally {
      setBusy(false);
    }
  };

  const options = localUserOptions(users ?? [], runner.localUserId);
  const away = runner.awayMode ?? false;

  return (
    <section aria-labelledby="runner-local" className="flex flex-col gap-4">
      <h3 id="runner-local" className="text-sm font-semibold">
        Claude Code sessions
      </h3>
      <Field
        label="Local user"
        htmlFor="runner-local-user"
        hint="Sessions started by hand on this machine, and the agentdock plugin's requests, act as this user, never above operator. With no user, every request is refused."
      >
        <Select
          id="runner-local-user"
          value={runner.localUserId ?? ''}
          disabled={disabled || busy || users === undefined}
          onChange={(e) =>
            void patch(
              { localUserId: e.target.value || null },
              'Local user saved',
            )
          }
        >
          <option value="">No local user</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-center justify-between gap-4">
        <div>
          <span id="runner-away-label" className="text-sm font-medium">
            Away mode
          </span>
          <p className="text-ink-3 text-xs">
            A tool permission prompt in a session on this machine goes to
            Approvals and Telegram instead of waiting in the terminal. If nobody
            answers in about five minutes, the terminal prompt shows.
          </p>
        </div>
        <Toggle
          checked={away}
          onChange={(next) =>
            void patch(
              { awayMode: next },
              next ? 'Away mode on' : 'Away mode off',
            )
          }
          labelledBy="runner-away-label"
        />
      </div>
    </section>
  );
}
