'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { Select } from '@andrewbehma/glass-ui/select';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import {
  BOARD_MAX_RUNNING_MAX,
  BOARD_MAX_RUNNING_MIN,
  type BoardSettingsView,
  CARD_BACKGROUND_STALL_MINUTES_MAX,
  CARD_BACKGROUND_STALL_MINUTES_MIN,
  type CaptureModel,
  type CardMergePolicy,
  isCardMergePolicy,
} from '@nautelle/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  AutoCollectToggle,
  CardOptionToggles,
} from '../../../../../components/board/card-options';
import {
  fetchBoardSettings,
  saveBoardSettings,
} from '../../../../../lib/board/actions';
import {
  AUTO_COLLECT_DEFAULT_HINT,
  AUTO_COLLECT_DEFAULT_LABEL,
  describeBoardError,
  parseMaxRunning,
  parseStallMinutes,
} from '../../../../../lib/board/format';
import {
  MERGE_POLICY_HINT,
  MERGE_POLICY_LABEL,
  MERGE_POLICY_OPTIONS,
} from '../../../../../lib/board/merge-policy';
import {
  AUTO_MERGE_LABEL,
  autoMergeHint,
  effectiveAutoMerge,
} from '../../../../../lib/board/shipping';
import { Time } from '../../../../../lib/format/time';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import { CaptureFields, CapturesTable } from './capture-section';

/** Board defaults of the project (issue #242 D2, D13). A project admin edits them. */
export function BoardTab({
  projectId,
  isAdmin,
  canOperate,
  contentOn,
}: {
  projectId: string;
  isAdmin: boolean;
  canOperate: boolean;
  /** `shipSessionContent` of the project: capture needs it (#244 D10). */
  contentOn: boolean;
}) {
  const [settings, setSettings] = useState<BoardSettingsView>();
  const [issueOnRun, setIssueOnRun] = useState(false);
  const [specOnRun, setSpecOnRun] = useState(false);
  const [autoCollectTracked, setAutoCollectTracked] = useState(false);
  const [autoMerge, setAutoMerge] = useState(false);
  const [mergePolicy, setMergePolicy] = useState<CardMergePolicy>('ask');
  const [maxRunning, setMaxRunning] = useState('3');
  const [stallMinutes, setStallMinutes] = useState('30');
  const [captureEnabled, setCaptureEnabled] = useState(false);
  const [captureModel, setCaptureModel] = useState<CaptureModel>('haiku');
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const load = useCallback(async () => {
    try {
      const view = await fetchBoardSettings(projectId);
      setSettings(view);
      setIssueOnRun(view.issueOnRun);
      setSpecOnRun(view.specOnRun);
      setAutoCollectTracked(view.autoCollectTracked);
      setAutoMerge(effectiveAutoMerge(view));
      setMergePolicy(view.cardMergePolicy);
      setMaxRunning(String(view.maxRunning));
      setStallMinutes(String(view.backgroundStallMinutes));
      setCaptureEnabled(view.captureEnabled);
      setCaptureModel(view.captureModel);
    } catch (err) {
      showError(describeBoardError(err));
    }
  }, [projectId, showError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings) return <Skeleton className="h-64 w-full" />;

  const limit = parseMaxRunning(maxRunning);
  const stall = parseStallMinutes(stallMinutes);
  const dirty =
    issueOnRun !== settings.issueOnRun ||
    specOnRun !== settings.specOnRun ||
    autoCollectTracked !== settings.autoCollectTracked ||
    autoMerge !== effectiveAutoMerge(settings) ||
    mergePolicy !== settings.cardMergePolicy ||
    limit !== settings.maxRunning ||
    stall !== settings.backgroundStallMinutes ||
    captureEnabled !== settings.captureEnabled ||
    captureModel !== settings.captureModel;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (limit === null || stall === null) return;
    setBusy(true);
    try {
      await saveBoardSettings(projectId, {
        issueOnRun,
        specOnRun,
        autoCollectTracked,
        // Untouched keeps the stored value, so a project following the default keeps following it.
        ...(autoMerge !== effectiveAutoMerge(settings)
          ? { autoMergeCards: autoMerge }
          : {}),
        cardMergePolicy: mergePolicy,
        maxRunning: limit,
        backgroundStallMinutes: stall,
        captureEnabled: captureEnabled && contentOn,
        captureModel,
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
    <div className="flex flex-col gap-4">
      <Card pad="lg">
        <form className="flex flex-col gap-6" onSubmit={save}>
          <div className="flex flex-col gap-4">
            <p className="text-ink-2 text-sm">
              What a new card starts with, and how many card workers one project
              runs at once. A card can override the toggles.
            </p>
            <CardOptionToggles
              projectId={projectId}
              idPrefix="board-set"
              issueOnRun={issueOnRun}
              specOnRun={specOnRun}
              disabled={!isAdmin}
              onIssueOnRun={setIssueOnRun}
              onSpecOnRun={setSpecOnRun}
            />
            <AutoCollectToggle
              id="board-set-auto-collect"
              checked={autoCollectTracked}
              disabled={!isAdmin}
              label={AUTO_COLLECT_DEFAULT_LABEL}
              hint={AUTO_COLLECT_DEFAULT_HINT}
              onChange={setAutoCollectTracked}
            />
            <AutoCollectToggle
              id="board-set-auto-merge"
              checked={autoMerge}
              disabled={!isAdmin}
              label={AUTO_MERGE_LABEL}
              hint={autoMergeHint(
                settings,
                autoMerge,
                settings.autoMergeCards === null &&
                  autoMerge === effectiveAutoMerge(settings),
              )}
              onChange={setAutoMerge}
            />
            <Field
              label={MERGE_POLICY_LABEL}
              htmlFor="board-set-merge-policy"
              hint={MERGE_POLICY_HINT}
            >
              <Select
                id="board-set-merge-policy"
                value={mergePolicy}
                disabled={!isAdmin}
                onChange={(e) => {
                  if (isCardMergePolicy(e.target.value))
                    setMergePolicy(e.target.value);
                }}
              >
                {MERGE_POLICY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
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
            <Field
              label="Background wait warning, minutes"
              htmlFor="board-set-stall"
              hint="A worker that ended its turn waiting on its own background task this long raises a warning and a notification."
              error={
                stall === null
                  ? `Enter a whole number from ${CARD_BACKGROUND_STALL_MINUTES_MIN} to ${CARD_BACKGROUND_STALL_MINUTES_MAX}.`
                  : undefined
              }
            >
              <Input
                id="board-set-stall"
                inputMode="numeric"
                value={stallMinutes}
                disabled={!isAdmin}
                onChange={(e) => setStallMinutes(e.target.value)}
              />
            </Field>
          </div>
          <CaptureFields
            projectId={projectId}
            isAdmin={isAdmin}
            contentOn={contentOn}
            enabled={captureEnabled}
            model={captureModel}
            onEnabled={setCaptureEnabled}
            onModel={setCaptureModel}
          />
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
                disabled={busy || !dirty || limit === null || stall === null}
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
      {canOperate ? <CapturesTable projectId={projectId} /> : null}
    </div>
  );
}
