'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Field } from '@andrewbehma/glass-ui/field';
import { NumberInput } from '@andrewbehma/glass-ui/number-input';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { type FormEvent, useCallback, useMemo, useState } from 'react';
import { useErrorToast } from '../../lib/section/use-error-toast';
import { useSection } from '../../lib/section/use-section';
import {
  fetchTokenEconomyReport,
  saveTokenEconomySettings,
} from '../../lib/token-saver/actions';
import { parseBShare } from '../../lib/token-saver/economy';
import { describeTokenSaverError } from '../../lib/token-saver/format';
import { presetRange } from '../../lib/usage/format';
import { AsyncSection } from '../prerequisites/async-section';

/**
 * #746 D2: the share of new cards drawn into arm B of every A/B-tested
 * technique. A project admin edits it; everyone else reads it. The API has
 * no settings read of its own, so the value comes from the report.
 */
export function BShareCard({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const range = useMemo(() => presetRange('30d'), []);
  const section = useSection(
    async () => (await fetchTokenEconomyReport(projectId, range)).bSharePercent,
    [projectId, range],
  );
  const { setData } = section;
  const showError = useErrorToast();

  const save = useCallback(
    async (value: number) => {
      try {
        const view = await saveTokenEconomySettings(projectId, {
          bSharePercent: value,
        });
        toast.success('Test arm share saved.');
        setData(view.bSharePercent);
      } catch (err) {
        showError(describeTokenSaverError(err));
      }
    },
    [projectId, setData, showError],
  );

  return (
    <Card pad="lg">
      <AsyncSection
        section={section}
        skeleton={<Skeleton className="h-24 w-full" />}
        unavailable={{
          title: 'The test arm share is not answering',
          stillWorks: 'The token saver settings above still save.',
        }}
        empty={null}
      >
        {(stored) => (
          <BShareForm
            // A saved value restarts the draft from it.
            key={stored}
            isAdmin={isAdmin}
            stored={stored}
            onSave={save}
          />
        )}
      </AsyncSection>
    </Card>
  );
}

/** The field itself; `onSave` reports its own failure and never rejects. */
export function BShareForm({
  isAdmin,
  stored,
  onSave,
}: {
  isAdmin: boolean;
  stored: number;
  onSave: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(stored));
  const [busy, setBusy] = useState(false);
  const value = parseBShare(draft);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (value === null) return;
    setBusy(true);
    try {
      await onSave(value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={save}>
      <Field
        label="Share of cards in test arm B"
        htmlFor="token-economy-b-share"
        hint="Percent of new cards that run each technique under an A/B test; the rest are its control, arm A. A card keeps its arm for all its rounds, so a change applies to new cards only."
        error={value === null ? 'A whole number from 0 to 100.' : undefined}
      >
        <span className="flex items-center gap-2">
          <NumberInput
            id="token-economy-b-share"
            className="w-24"
            min={0}
            max={100}
            step={1}
            value={draft}
            readOnly={!isAdmin}
            aria-invalid={value === null || undefined}
            onChange={(e) => setDraft(e.target.value)}
          />
          <span className="text-ink-3 text-sm">%</span>
        </span>
      </Field>
      {isAdmin ? (
        <div className="flex justify-end">
          <Button
            variant="solid"
            type="submit"
            disabled={busy || value === null || value === stored}
          >
            Save
          </Button>
        </div>
      ) : (
        <p className="text-ink-3 text-sm">
          Only project administrators can change the test arm share.
        </p>
      )}
    </form>
  );
}
