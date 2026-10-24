'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Textarea } from '@andrewbehma/glass-ui/field';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import {
  DEMO_UI_PATH_MAX_LENGTH,
  DEMO_UI_PATHS_MAX,
  type DemoRunnerView,
  type DemoSecretView,
  type DemoSettingsView,
} from '@nautelle/shared';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { DemoRunnerStatus } from '../../../../../components/demos/demo-runner-status';
import { DemoSecretsEditor } from '../../../../../components/demos/demo-secrets-editor';
import {
  fetchDemoRunner,
  fetchDemoSecrets,
  fetchDemoSettings,
  saveDemoSettings,
} from '../../../../../lib/demos/actions';
import { describeDemoError } from '../../../../../lib/demos/format';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';

/** One glob per line, blanks and repeats dropped. */
export const parseUiPaths = (text: string): string[] => [
  ...new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];

/** A message when the globs cannot be saved, else `undefined`. */
export function uiPathsError(paths: readonly string[]): string | undefined {
  if (paths.length > DEMO_UI_PATHS_MAX) {
    return `At most ${DEMO_UI_PATHS_MAX} paths.`;
  }
  if (paths.some((p) => p.length > DEMO_UI_PATH_MAX_LENGTH)) {
    return `A path is at most ${DEMO_UI_PATH_MAX_LENGTH} characters.`;
  }
  return undefined;
}

/** A glass-ui `Toggle` that is inert and dimmed for a viewer who cannot change it. */
function Switch({
  id,
  checked,
  locked,
  label,
  onChange,
}: {
  id: string;
  checked: boolean;
  locked: boolean;
  label: ReactNode;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        aria-disabled={locked || undefined}
        inert={locked || undefined}
        className={locked ? 'opacity-60' : undefined}
      >
        <Toggle labelledBy={id} checked={checked} onChange={onChange} />
      </span>
      <span id={id}>{label}</span>
    </div>
  );
}

/**
 * C-371 (ADR-0090): Settings → Demo videos — the switch, the UI paths, Telegram,
 * the Demo env secrets and the runner's DemoFlow status, as plain sections in
 * that order. A project admin changes them; everyone else reads.
 */
export function DemoVideosTab({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const [settings, setSettings] = useState<DemoSettingsView>();
  const [secrets, setSecrets] = useState<DemoSecretView[]>();
  const [runner, setRunner] = useState<DemoRunnerView>();
  const [paths, setPaths] = useState('');
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const adopt = useCallback((view: DemoSettingsView) => {
    setSettings(view);
    setPaths(view.uiPaths.join('\n'));
  }, []);

  useEffect(() => {
    let current = true;
    Promise.all([
      fetchDemoSettings(projectId),
      fetchDemoSecrets(projectId),
      fetchDemoRunner(projectId),
    ])
      .then(([view, list, status]) => {
        if (!current) return;
        adopt(view);
        setSecrets(list);
        setRunner(status);
      })
      .catch((err) => {
        if (current) showError(describeDemoError(err));
      });
    return () => {
      current = false;
    };
  }, [projectId, adopt, showError]);

  if (!settings || !secrets || !runner) {
    return <Skeleton className="h-64 w-full" />;
  }

  const save = async (
    body: Parameters<typeof saveDemoSettings>[1],
    saved: string,
  ) => {
    setBusy(true);
    try {
      adopt(await saveDemoSettings(projectId, body));
      toast.success(saved);
    } catch (err) {
      showError(describeDemoError(err));
    } finally {
      setBusy(false);
    }
  };

  const parsed = parseUiPaths(paths);
  const pathsError = uiPathsError(parsed);
  const pathsDirty = parsed.join('\n') !== settings.uiPaths.join('\n');

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Demo videos"
        description="Record a short video of a finished card's change and show it on the card."
      >
        <Switch
          id="demo-videos-enabled"
          checked={settings.enabled}
          locked={!isAdmin || busy}
          label="Record a demo for finished UI cards"
          onChange={(enabled) =>
            void save({ enabled }, enabled ? 'Demos are on.' : 'Demos are off.')
          }
        />
        <p className="mt-2 text-ink-3 text-xs">
          A failed demo never blocks merging. Off, no card is recorded and the
          Demo section is not drawn.
        </p>
      </Section>

      <Section
        title="UI paths"
        description="A card whose branch changes a file matching any of these globs is a UI card."
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (pathsError) return;
            void save({ uiPaths: parsed }, 'UI paths saved.');
          }}
        >
          <Field
            label="Globs, one per line"
            htmlFor="demo-ui-paths"
            error={pathsError}
          >
            <Textarea
              id="demo-ui-paths"
              rows={4}
              value={paths}
              readOnly={!isAdmin}
              spellCheck={false}
              className="font-mono"
              onChange={(e) => setPaths(e.target.value)}
            />
          </Field>
          {isAdmin ? (
            <div className="flex justify-end">
              <Button
                variant="solid"
                type="submit"
                disabled={busy || !pathsDirty || pathsError !== undefined}
              >
                Save
              </Button>
            </div>
          ) : null}
        </form>
      </Section>

      <Section
        title="Telegram"
        description="Where a ready demo is also delivered."
      >
        <Switch
          id="demo-videos-telegram"
          checked={settings.telegram}
          locked={!isAdmin || busy}
          label="Send a ready demo to the project's Telegram chat"
          onChange={(telegram) =>
            void save(
              { telegram },
              telegram
                ? 'Telegram delivery is on.'
                : 'Telegram delivery is off.',
            )
          }
        />
      </Section>

      <Section
        title="Demo env"
        description="Environment values the scenario reads, such as a demo account's password."
      >
        <p className="mb-3 text-ink-3 text-xs">
          Use demo accounts, never production credentials: the recording shows
          what the scenario does on screen.
        </p>
        <DemoSecretsEditor
          projectId={projectId}
          isAdmin={isAdmin}
          secrets={secrets}
          onChanged={setSecrets}
        />
      </Section>

      <Section
        title="DemoFlow on the runner"
        description="What the project's runner reports about recording."
      >
        <DemoRunnerStatus runner={runner} />
      </Section>
    </div>
  );
}
