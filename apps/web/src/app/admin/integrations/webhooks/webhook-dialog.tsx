'use client';

import {
  type ProjectSummary,
  WEBHOOK_EVENT_TYPES,
  type WebhookView,
  type WebhookWithSecret,
} from '@agentdock/shared';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { Checkbox } from 'glass-ui/checkbox';
import { Combobox } from 'glass-ui/combobox';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Input } from 'glass-ui/field';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../../../lib/api';
import {
  describeWebhooksError,
  emptyWebhookForm,
  formFromWebhook,
  sortEvents,
  toWebhookCreateRequest,
  toWebhookUpdateRequest,
  type WebhookForm,
  webhookFormProblem,
} from '../../../../lib/webhooks/format';

/**
 * Creates or edits an outbound webhook (spec 26 UI). On create the response
 * carries the secret; it is handed to `onCreated` and nowhere else.
 */
export function WebhookDialog({
  open,
  webhook,
  projects,
  onClose,
  onCreated,
  onSaved,
}: {
  open: boolean;
  webhook?: WebhookView;
  projects: ProjectSummary[];
  onClose: () => void;
  onCreated: (created: WebhookWithSecret) => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<WebhookForm>(emptyWebhookForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setForm(webhook ? formFromWebhook(webhook) : emptyWebhookForm());
    setError(undefined);
  }, [open, webhook]);

  const problem = webhookFormProblem(form);
  const projectOptions = useMemo(
    () => projects.map((p) => ({ value: p.id, label: p.displayName })),
    [projects],
  );

  const toggleEvent = (type: (typeof WEBHOOK_EVENT_TYPES)[number]) =>
    setForm((current) => ({
      ...current,
      events: sortEvents(
        current.events.includes(type)
          ? current.events.filter((e) => e !== type)
          : [...current.events, type],
      ),
    }));

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(undefined);
    try {
      if (webhook) {
        const patch = toWebhookUpdateRequest(form, webhook);
        if (Object.keys(patch).length > 0) {
          await api(`/admin/webhooks/${webhook.id}`, {
            method: 'PATCH',
            body: patch,
          });
        }
        onSaved();
      } else {
        onCreated(
          await api<WebhookWithSecret>('/admin/webhooks', {
            method: 'POST',
            body: toWebhookCreateRequest(form),
          }),
        );
      }
    } catch (err) {
      setError(describeWebhooksError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        title={webhook ? 'Edit webhook' : 'New webhook'}
        description="AgentDock POSTs the chosen events to this URL, signed with the webhook’s secret."
        footer={
          <>
            <Button variant="glass" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy || problem !== null} onClick={submit}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Name" htmlFor="webhook-name" required>
            <Input
              id="webhook-name"
              value={form.name}
              maxLength={100}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field
            label="URL"
            htmlFor="webhook-url"
            required
            hint="https:// only, unless the host is on the private-target allowlist."
          >
            <Input
              id="webhook-url"
              type="url"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium text-ink-2">
              Events
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {WEBHOOK_EVENT_TYPES.map((type) => (
                <Checkbox
                  key={type}
                  label={type}
                  checked={form.events.includes(type)}
                  onChange={() => toggleEvent(type)}
                />
              ))}
            </div>
          </fieldset>
          <Field label="Projects" hint="Leave empty for every project.">
            <Combobox
              multiple
              aria-label="Projects"
              placeholder="All projects"
              options={projectOptions}
              value={form.projectIds}
              onValueChange={(projectIds) => setForm({ ...form, projectIds })}
            />
          </Field>
          {problem && form.name.trim() !== '' ? (
            <p className="text-xs text-ink-3" role="status">
              {problem}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
