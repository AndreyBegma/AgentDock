'use client';

import {
  BOARD_MAX_RUNNING_MAX,
  BOARD_MAX_RUNNING_MIN,
  type BoardSettingsView,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { CardOptionToggles } from '../../../../../components/board/card-options';
import {
  fetchBoardSettings,
  saveBoardSettings,
} from '../../../../../lib/board/actions';
import {
  describeBoardError,
  parseMaxRunning,
} from '../../../../../lib/board/format';
import { Time } from '../../../../../lib/format/time';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';

/** Board defaults of the project (issue #242 D2, D13). A project admin edits them. */
export function BoardTab({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const [settings, setSettings] = useState<BoardSettingsView>();
  const [issueOnRun, setIssueOnRun] = useState(false);
  const [specOnRun, setSpecOnRun] = useState(false);
  const [maxRunning, setMaxRunning] = useState('3');
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const load = useCallback(async () => {
    try {
      const view = await fetchBoardSettings(projectId);
      setSettings(view);
      setIssueOnRun(view.issueOnRun);
      setSpecOnRun(view.specOnRun);
      setMaxRunning(String(view.maxRunning));
    } catch (err) {
      showError(describeBoardError(err));
    }
  }, [projectId, showError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings) return <Skeleton className="h-64 w-full" />;

  const limit = parseMaxRunning(maxRunning);
  const dirty =
    issueOnRun !== settings.issueOnRun ||
    specOnRun !== settings.specOnRun ||
    limit !== settings.maxRunning;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (limit === null) return;
    setBusy(true);
    try {
      await saveBoardSettings(projectId, {
        issueOnRun,
        specOnRun,
        maxRunning: limit,
      });
      toast.success('Board settings saved.');
      await load();
    } catch (err) {
      showError(describeBoardError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card pad="lg">
      <form className="flex flex-col gap-4" onSubmit={save}>
        <p className="text-ink-2 text-sm">
          What a new card starts with, and how many card workers one project
          runs at once. A card can override the toggles.
        </p>
        <CardOptionToggles
          idPrefix="board-set"
          issueOnRun={issueOnRun}
          specOnRun={specOnRun}
          disabled={!isAdmin}
          onIssueOnRun={setIssueOnRun}
          onSpecOnRun={setSpecOnRun}
        />
        <Field
          label="Workers at once"
          htmlFor="board-set-max"
          hint={`Between ${BOARD_MAX_RUNNING_MIN} and ${BOARD_MAX_RUNNING_MAX}. A further Run is refused until one finishes.`}
          error={
            limit === null
              ? `Enter a whole number from ${BOARD_MAX_RUNNING_MIN} to ${BOARD_MAX_RUNNING_MAX}.`
              : undefined
          }
        >
          <Input
            id="board-set-max"
            inputMode="numeric"
            value={maxRunning}
            disabled={!isAdmin}
            onChange={(e) => setMaxRunning(e.target.value)}
          />
        </Field>
        {isAdmin ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-3 text-xs">
              {settings.updatedAt ? (
                <>
                  Last changed <Time value={settings.updatedAt} />
                </>
              ) : (
                'Never changed — built-in defaults.'
              )}
            </span>
            <Button
              variant="solid"
              type="submit"
              disabled={busy || !dirty || limit === null}
            >
              Save
            </Button>
          </div>
        ) : (
          <p className="text-ink-3 text-sm">
            Only project administrators can change these settings.
          </p>
        )}
      </form>
    </Card>
  );
}
