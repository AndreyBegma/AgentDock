'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import type {
  ProjectRuntimeProfile,
  TokenSaverSettingsView,
} from '@nautelle/shared';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Time } from '../../../../../lib/format/time';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import {
  fetchRuntimeProfiles,
  fetchTokenSaver,
  saveTokenSaver,
} from '../../../../../lib/token-saver/actions';
import {
  describeTokenSaverError,
  mcpChoices,
  profilesReportServers,
  sameAllow,
  toggleAllow,
} from '../../../../../lib/token-saver/format';

/**
 * #445 D11: the project's Token saver — a switch (on by default) and the MCP
 * allowlist (D6). A project admin saves; everyone else reads. The allowlist
 * is picked from the servers the runner reports for the project's profiles,
 * which only an operator can read.
 */
export function TokenSaverTab({
  projectId,
  isAdmin,
  canOperate,
}: {
  projectId: string;
  isAdmin: boolean;
  canOperate: boolean;
}) {
  const [settings, setSettings] = useState<TokenSaverSettingsView>();
  const [profiles, setProfiles] = useState<ProjectRuntimeProfile[]>();
  const [enabled, setEnabled] = useState(true);
  const [allow, setAllow] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const load = useCallback(async () => {
    try {
      const view = await fetchTokenSaver(projectId);
      setSettings(view);
      setEnabled(view.enabled);
      setAllow(view.mcpAllow);
    } catch (err) {
      showError(describeTokenSaverError(err));
    }
  }, [projectId, showError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canOperate) {
      setProfiles([]);
      return;
    }
    let current = true;
    fetchRuntimeProfiles(projectId)
      .then((list) => {
        if (current) setProfiles(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        // The checkboxes fall back to the stored names; saving still works.
        if (current) setProfiles([]);
      });
    return () => {
      current = false;
    };
  }, [projectId, canOperate]);

  if (!settings || !profiles) return <Skeleton className="h-64 w-full" />;

  const choices = mcpChoices(profiles, allow);
  const dirty =
    enabled !== settings.enabled || !sameAllow(allow, settings.mcpAllow);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const view = await saveTokenSaver(projectId, {
        enabled,
        mcpAllow: allow,
      });
      setSettings(view);
      setEnabled(view.enabled);
      setAllow(view.mcpAllow);
      toast.success('Token saver saved.');
    } catch (err) {
      showError(describeTokenSaverError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card pad="lg">
      <form className="flex flex-col gap-6" onSubmit={save}>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-sm">
            {/* glass-ui's Toggle has no `disabled`: a locked one is inert and dimmed. */}
            <span
              aria-disabled={!isAdmin || undefined}
              inert={!isAdmin || undefined}
              className={isAdmin ? undefined : 'opacity-60'}
            >
              <Toggle
                labelledBy="token-saver-enabled"
                checked={enabled}
                onChange={(value) => {
                  if (isAdmin) setEnabled(value);
                }}
              />
            </span>
            <span id="token-saver-enabled">Token saver</span>
          </div>
          <p className="text-ink-3 text-xs">
            Compresses what agents read — command output, unused MCP tool
            schemas, a long history — and never what people read: questions,
            specs, pull-request descriptions and summaries stay complete. Off
            launches every agent exactly as before.{' '}
            <Link
              href={`/projects/${encodeURIComponent(projectId)}/token-saver`}
              className="text-accent-ink underline underline-offset-2"
            >
              See what it saved
            </Link>
            .
          </p>
        </div>

        <fieldset
          className="flex flex-col gap-2"
          disabled={!isAdmin || !enabled}
        >
          <legend className="font-medium text-sm">
            MCP servers agents load
          </legend>
          <p className="text-ink-3 text-xs">
            <code>agentdock</code> is always loaded. A server left unticked is
            not loaded, so its tool schemas cost no tokens.{' '}
            {choices.length === 0
              ? 'None are allowed — agents get agentdock only.'
              : null}
          </p>
          {choices.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {choices.map(({ name, reported }) => (
                <li key={name}>
                  <Checkbox
                    id={`token-saver-mcp-${name}`}
                    label={name}
                    hint={
                      reported
                        ? undefined
                        : 'Allowed, but no profile of the runner reports it now.'
                    }
                    checked={allow.includes(name)}
                    onChange={(e) =>
                      setAllow((prev) =>
                        toggleAllow(prev, name, e.target.checked),
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {!canOperate ? (
            <p className="text-ink-3 text-xs">
              The runner's servers are listed for operators; you see the names
              already allowed.
            </p>
          ) : !profilesReportServers(profiles) ? (
            <p className="text-ink-3 text-xs">
              The runner reports no MCP servers for this project's profiles — an
              older runner, or a Codex profile. Update the runner to pick
              servers here.
            </p>
          ) : null}
        </fieldset>

        {isAdmin ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-3 text-xs">
              {settings.updatedAt ? (
                <>
                  Last changed <Time value={settings.updatedAt} />
                </>
              ) : (
                'Never changed — on, agentdock only.'
              )}
            </span>
            <Button variant="solid" type="submit" disabled={busy || !dirty}>
              Save
            </Button>
          </div>
        ) : (
          <p className="text-ink-3 text-sm">
            Only project administrators can change Token saver.
          </p>
        )}
      </form>
    </Card>
  );
}
