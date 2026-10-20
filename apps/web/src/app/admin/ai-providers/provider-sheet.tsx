'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { toast } from '@andrewbehma/glass-ui/toast';
import type {
  LlmDefaultModel,
  LlmKeyTestResult,
  LlmProviderView,
  LlmSettingsView,
} from '@nautelle/shared';
import { type FormEvent, useState } from 'react';
import { api, errorText } from '../../../lib/api';
import { formatCost, formatNumber, formatTokens } from '../../../lib/format';
import { Time } from '../../../lib/format/time';
import {
  describeLlmError,
  maskedKey,
  parseCap,
  resetDay,
} from '../../../lib/llm/format';
import { useErrorToast } from '../../../lib/section/use-error-toast';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/** One provider's key, cap and models (ADR-0059). */
export function ProviderSheet({
  provider,
  gatewayAvailable,
  defaultModel,
  resetsAt,
  onClose,
  onSaved,
}: {
  provider: LlmProviderView;
  gatewayAvailable: boolean;
  defaultModel: LlmDefaultModel | null;
  resetsAt: string;
  onClose: () => void;
  onSaved: (state: LlmSettingsView) => void;
}) {
  const path = `/admin/llm/providers/${provider.provider}`;
  const showError = useErrorToast();
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string>();
  const [cap, setCap] = useState(Number(provider.capUsd).toString());
  const [models, setModels] = useState<string[]>(
    provider.models.map((m) => m.id),
  );
  const [extra, setExtra] = useState('');
  const [settingsError, setSettingsError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const offered = [
    ...new Set([
      ...provider.suggestedModels,
      ...provider.models.map((m) => m.id),
      ...models,
    ]),
  ];
  const unpriced = new Set(
    provider.models.filter((m) => !m.priced).map((m) => m.id),
  );
  const isDefault = (model: string) =>
    defaultModel?.provider === provider.provider &&
    defaultModel.model === model;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const saveKey = (event: FormEvent) => {
    event.preventDefault();
    setKeyError(undefined);
    void run(async () => {
      try {
        const state = await api<LlmSettingsView>(`${path}/key`, {
          method: 'PUT',
          body: { key: key.trim() },
        });
        // The key is gone from the page the moment it is sent.
        setKey('');
        onSaved(state);
        toast.success(`${provider.label} key saved.`);
      } catch (err) {
        setKeyError(errorText(describeLlmError(err)));
      }
    });
  };

  const testKey = () =>
    run(async () => {
      try {
        const result = await api<LlmKeyTestResult>(`${path}/key/test`, {
          method: 'POST',
        });
        toast.success(
          `${provider.label} accepted the key (${result.latencyMs} ms).`,
        );
      } catch (err) {
        showError(describeLlmError(err));
      }
    });

  const removeKey = () =>
    run(async () => {
      try {
        onSaved(
          await api<LlmSettingsView>(`${path}/key`, { method: 'DELETE' }),
        );
        setConfirmRemove(false);
        toast.success(`${provider.label} key removed.`);
      } catch (err) {
        showError(describeLlmError(err));
      }
    });

  const addModel = () => {
    const id = extra.trim();
    if (!MODEL_ID.test(id)) {
      setSettingsError('A model id is letters, digits and . _ : / @ -');
      return;
    }
    setSettingsError(undefined);
    if (!models.includes(id)) setModels([...models, id]);
    setExtra('');
  };

  const saveSettings = () => {
    const capUsd = parseCap(cap);
    if (capUsd === null) {
      setSettingsError('The cap is dollars, with at most two decimals.');
      return;
    }
    setSettingsError(undefined);
    void run(async () => {
      try {
        onSaved(
          await api<LlmSettingsView>(path, {
            method: 'PATCH',
            body: { capUsd, models },
          }),
        );
        toast.success(`${provider.label} settings saved.`);
        onClose();
      } catch (err) {
        setSettingsError(errorText(describeLlmError(err)));
      }
    });
  };

  return (
    <SheetRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        title={provider.label}
        description={
          provider.enabled
            ? `${formatCost(provider.spendUsd)} of ${formatCost(provider.capUsd)} this month · resets ${resetDay(resetsAt)}`
            : 'Disabled until it has a cap above 0'
        }
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="solid" onClick={saveSettings} disabled={busy}>
              Save
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-4">
            <SectionHeader headingLevel={3} title="API key" />
            {provider.key.configured ? (
              <div className="flex flex-col gap-1 text-sm">
                <span className="font-mono">
                  {maskedKey(provider.key.suffix)}
                </span>
                <span className="text-xs text-ink-3">
                  Set <Time value={provider.key.updatedAt} />
                </span>
              </div>
            ) : (
              <p className="text-sm text-ink-2">No key is set.</p>
            )}
            <form onSubmit={saveKey} className="flex flex-col gap-3">
              <Field
                label={provider.key.configured ? 'Replace the key' : 'Key'}
                htmlFor="llm-key"
                hint="Stored encrypted. Nautelle never shows or returns the full key; replacing it overwrites the old one."
                error={keyError}
              >
                <Input
                  id="llm-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  disabled={!gatewayAvailable || busy}
                  onChange={(e) => setKey(e.target.value)}
                />
              </Field>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  variant="glass"
                  disabled={!gatewayAvailable || busy || key.trim() === ''}
                >
                  {provider.key.configured ? 'Replace key' : 'Save key'}
                </Button>
                {provider.key.configured ? (
                  <>
                    <Button
                      variant="glass"
                      disabled={!gatewayAvailable || busy}
                      onClick={() => void testKey()}
                    >
                      Test key
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => setConfirmRemove(true)}
                    >
                      Remove key
                    </Button>
                  </>
                ) : null}
              </div>
            </form>
          </section>

          <section className="flex flex-col gap-4">
            <SectionHeader headingLevel={3} title="Monthly cap" />
            <Field
              label="Cap (USD)"
              htmlFor="llm-cap"
              hint={`Calls stop when this month's spend reaches the cap; 0 disables ${provider.label}. ${formatCost(provider.spendUsd)} used · resets ${resetDay(resetsAt)}, 00:00 UTC.`}
            >
              <Input
                id="llm-cap"
                inputMode="decimal"
                value={cap}
                disabled={busy}
                onChange={(e) => setCap(e.target.value)}
              />
            </Field>
          </section>

          <section className="flex flex-col gap-4">
            <SectionHeader
              headingLevel={3}
              title="Enabled models"
              description="A model needs a price under Admin › Prices before it can be enabled."
            />
            <div className="flex flex-col gap-2">
              {offered.map((model) => (
                <Checkbox
                  key={model}
                  label={model}
                  hint={
                    isDefault(model)
                      ? 'The instance default'
                      : unpriced.has(model)
                        ? 'No longer priced — calls to it are refused'
                        : undefined
                  }
                  checked={models.includes(model)}
                  disabled={
                    busy || (isDefault(model) && models.includes(model))
                  }
                  onChange={(e) =>
                    setModels(
                      e.target.checked
                        ? [...models, model]
                        : models.filter((m) => m !== model),
                    )
                  }
                />
              ))}
            </div>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Field label="Another model id" htmlFor="llm-extra-model">
                  <Input
                    id="llm-extra-model"
                    value={extra}
                    disabled={busy}
                    placeholder="e.g. claude-sonnet-5-5"
                    onChange={(e) => setExtra(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addModel();
                      }
                    }}
                  />
                </Field>
              </div>
              <Button
                variant="glass"
                disabled={busy || extra.trim() === ''}
                onClick={addModel}
              >
                Add
              </Button>
            </div>
            {settingsError ? (
              <p role="alert" className="text-sm text-danger">
                {settingsError}
              </p>
            ) : null}
          </section>

          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-ink-3">Requests</dt>
              <dd className="tabular-nums">
                {formatNumber(provider.requests)}
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">Input tokens</dt>
              <dd className="tabular-nums">
                {formatTokens(provider.inputTokens)}
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">Output tokens</dt>
              <dd className="tabular-nums">
                {formatTokens(provider.outputTokens)}
              </dd>
            </div>
          </dl>
        </div>

        <ConfirmDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={`Remove the ${provider.label} key?`}
          consequence={`Calls to ${provider.label} are refused until a new key is set.`}
          verb="Remove key"
          tone="danger"
          busy={busy}
          onConfirm={() => void removeKey()}
        />
      </SheetContent>
    </SheetRoot>
  );
}
