'use client';

import { claudeModelOptions, PLANNING_MODEL_DEFAULT } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Field, Select } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useEffect, useState } from 'react';
import { AsyncSection } from '../../components/prerequisites/async-section';
import { describeError } from '../../lib/api';
import {
  saveUserSettings,
  useUserSettings,
} from '../../lib/settings/user-settings';

/**
 * #337 D9: the model New work interviews run on (#409) unless the person
 * picks another at the start. The catalog's aliases (#322 D4);
 * Reset goes back to the default.
 */
export function PlanningModelCard() {
  const settings = useUserSettings();
  const [model, setModel] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const stored = settings.data?.planningModel;

  useEffect(() => {
    if (stored !== undefined) setModel(stored);
  }, [stored]);

  const save = async (planningModel: string | null) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await saveUserSettings({ planningModel });
      settings.setData(next);
      toast.success(
        planningModel === null
          ? 'Planning model reset to the default.'
          : 'Planning model saved.',
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card pad="lg">
      <SectionHeader
        className="mb-4"
        title="Planning model"
        description="New work interviews start on this model. You can pick another for one request when you start it."
      />
      <AsyncSection
        section={settings}
        unavailable={{
          title: 'Your settings could not be loaded',
          stillWorks: 'New work still starts, on the default model.',
        }}
        empty={null}
        isEmpty={() => false}
        skeleton={<Skeleton className="h-16 w-full max-w-sm" />}
      >
        {() => (
          <form
            className="flex max-w-sm flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (model) void save(model);
            }}
          >
            <Field
              label="Model"
              htmlFor="planning-model"
              hint={`The default is ${PLANNING_MODEL_DEFAULT}.`}
              error={error}
            >
              <Select
                id="planning-model"
                value={model ?? ''}
                disabled={busy}
                onChange={(e) => setModel(e.target.value)}
              >
                {claudeModelOptions({
                  selected: model,
                  recommended: PLANNING_MODEL_DEFAULT,
                }).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="solid"
                disabled={busy || !model || model === stored}
              >
                Save
              </Button>
              <Button
                variant="glass"
                disabled={busy || stored === PLANNING_MODEL_DEFAULT}
                onClick={() => void save(null)}
              >
                Reset to default
              </Button>
            </div>
          </form>
        )}
      </AsyncSection>
    </Card>
  );
}
