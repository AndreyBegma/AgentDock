'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Field, Select } from '@andrewbehma/glass-ui/field';
import { Progress } from '@andrewbehma/glass-ui/progress';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { toast } from '@andrewbehma/glass-ui/toast';
import type {
  LlmProviderId,
  LlmProviderView,
  LlmSettingsView,
} from '@nautelle/shared';
import { useState } from 'react';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { PrerequisiteBanner } from '../../../components/prerequisites/prerequisite-banner';
import { api } from '../../../lib/api';
import { formatCost, formatNumber, formatTokens } from '../../../lib/format';
import {
  capPercent,
  capTone,
  describeLlmError,
  maskedKey,
  monthName,
  providerStatus,
  resetDay,
} from '../../../lib/llm/format';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { useSection } from '../../../lib/section/use-section';
import { ProviderSheet } from './provider-sheet';

const PATH = '/admin/llm';

/** `anthropic:claude-opus-5-5` — one option of the default-model picker. */
const optionValue = (provider: LlmProviderId, model: string) =>
  `${provider}:${model}`;

export default function AiProvidersPage() {
  const section = useSection(() => api<LlmSettingsView>(PATH), []);
  const showError = useErrorToast();
  const [editing, setEditing] = useState<LlmProviderId>();
  const [savingDefault, setSavingDefault] = useState(false);

  const setDefault = async (value: string) => {
    const at = value.indexOf(':');
    if (at < 0) return;
    setSavingDefault(true);
    try {
      section.setData(
        await api<LlmSettingsView>(`${PATH}/default-model`, {
          method: 'PUT',
          body: { provider: value.slice(0, at), model: value.slice(at + 1) },
        }),
      );
      toast.success('Default model saved.');
    } catch (err) {
      showError(describeLlmError(err));
    } finally {
      setSavingDefault(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        title="AI providers"
        description="Keys and monthly caps for the models Nautelle calls directly: the assistant, the digest, summaries, Board search and triage hints. Spend resets on the 1st at 00:00 UTC."
      />

      <AsyncSection
        section={section}
        unavailable={{
          title: 'The AI provider settings are not answering',
          stillWorks:
            'Runner work — the Planner, card workers and Steward — is not affected.',
        }}
        isEmpty={() => false}
        empty={null}
        skeleton={<Skeleton className="h-96 w-full" />}
      >
        {(state) => {
          const month = monthName(state.month.start);
          const reset = resetDay(state.month.resetsAt);
          const capTotal = state.providers
            .filter((p) => p.enabled)
            .reduce((sum, p) => sum + Number(p.capUsd), 0);
          const reached = state.providers.filter((p) => p.capReached);
          const enabledModels = state.providers.flatMap((p) =>
            p.models.map((m) => ({ provider: p, model: m.id })),
          );
          const editingProvider = state.providers.find(
            (p) => p.provider === editing,
          );
          return (
            <>
              {state.gatewayAvailable ? null : (
                <PrerequisiteBanner
                  tone="warn"
                  title="No usable LLM_SECRETS_KEY on the server"
                  body="Provider keys are stored encrypted with it, so the gateway is off: no key can be set and no AI feature runs. Set LLM_SECRETS_KEY in the API's environment to 32 random bytes, base64 (openssl rand -base64 32), and restart the API."
                />
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatTile
                  hue={1}
                  label={`Spend in ${month}`}
                  value={formatCost(state.totals.spendUsd)}
                  hint={
                    capTotal > 0
                      ? `of ${formatCost(capTotal)} across caps`
                      : 'No provider has a cap'
                  }
                />
                <StatTile
                  hue={2}
                  label="Requests"
                  value={formatNumber(state.totals.requests)}
                  hint={`resets ${reset}`}
                />
                <StatTile
                  hue={7}
                  label="Tokens"
                  value={formatTokens(
                    state.totals.inputTokens + state.totals.outputTokens,
                  )}
                  hint={`${formatTokens(state.totals.inputTokens)} in · ${formatTokens(state.totals.outputTokens)} out`}
                />
              </div>

              {reached.map((p) => (
                <Banner
                  key={p.provider}
                  tone="danger"
                  title={`${p.label} reached its ${formatCost(p.capUsd)} cap.`}
                  action={
                    <Button
                      size="sm"
                      variant="glass"
                      onClick={() => setEditing(p.provider)}
                    >
                      Raise cap
                    </Button>
                  }
                >
                  Calls to {p.label} are refused until {reset} or until you
                  raise the cap.
                </Banner>
              ))}

              <Card pad="lg">
                <SectionHeader
                  className="mb-4"
                  title="Providers"
                  description="Keys are stored encrypted; only the last four characters are ever shown. A provider with a cap of 0 is disabled."
                />
                <Table scroll>
                  <TableHead>
                    <TableRow>
                      <TableCell head>Provider</TableCell>
                      <TableCell head>Status</TableCell>
                      <TableCell head>Key</TableCell>
                      <TableCell head>Models</TableCell>
                      <TableCell head>{month}</TableCell>
                      <TableCell head>Cap</TableCell>
                      <TableCell head>
                        <span className="sr-only">Actions</span>
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <tbody>
                    {state.providers.map((p) => (
                      <ProviderRow
                        key={p.provider}
                        provider={p}
                        onEdit={() => setEditing(p.provider)}
                      />
                    ))}
                  </tbody>
                </Table>
              </Card>

              <Card pad="lg">
                <SectionHeader
                  className="mb-4"
                  title="Default model"
                  description="The model AI features use unless they name another. Only enabled models can be the default."
                />
                <div className="max-w-md">
                  <Field label="Instance default" htmlFor="llm-default-model">
                    <Select
                      id="llm-default-model"
                      disabled={savingDefault || enabledModels.length === 0}
                      value={
                        state.defaultModel
                          ? optionValue(
                              state.defaultModel.provider,
                              state.defaultModel.model,
                            )
                          : ''
                      }
                      onChange={(e) => void setDefault(e.target.value)}
                    >
                      <option value="" disabled>
                        {enabledModels.length === 0
                          ? 'Enable a model first'
                          : 'Choose a model'}
                      </option>
                      {enabledModels.map(({ provider, model }) => (
                        <option
                          key={optionValue(provider.provider, model)}
                          value={optionValue(provider.provider, model)}
                        >
                          {provider.label} · {model}
                          {provider.enabled ? '' : ' (provider disabled)'}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </Card>

              {editingProvider ? (
                <ProviderSheet
                  provider={editingProvider}
                  gatewayAvailable={state.gatewayAvailable}
                  defaultModel={state.defaultModel}
                  resetsAt={state.month.resetsAt}
                  onClose={() => setEditing(undefined)}
                  onSaved={(next) => section.setData(next)}
                />
              ) : null}
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

function ProviderRow({
  provider,
  onEdit,
}: {
  provider: LlmProviderView;
  onEdit: () => void;
}) {
  const status = providerStatus(provider);
  const tone = capTone(provider);
  return (
    <TableRow>
      <TableCell className="font-medium">{provider.label}</TableCell>
      <TableCell>
        <Badge tone={status.tone} label={status.label} />
      </TableCell>
      <TableCell className="font-mono text-xs">
        {provider.key.configured ? maskedKey(provider.key.suffix) : '—'}
      </TableCell>
      <TableCell className="text-ink-2">
        {provider.models.length === 0
          ? '—'
          : provider.models.map((m) => m.id).join(', ')}
      </TableCell>
      <TableCell className="min-w-36">
        {provider.enabled ? (
          <Progress
            value={capPercent(provider)}
            tone={tone === 'neutral' ? 'ok' : tone}
            label={formatCost(provider.spendUsd)}
            hint={`${capPercent(provider)}%`}
          />
        ) : (
          <span className="text-ink-3">{formatCost(provider.spendUsd)}</span>
        )}
      </TableCell>
      <TableCell className="tabular-nums">
        {provider.enabled ? formatCost(provider.capUsd) : 'Disabled'}
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" variant="glass" onClick={onEdit}>
          {provider.key.configured ? 'Edit' : 'Add key'}
        </Button>
      </TableCell>
    </TableRow>
  );
}
