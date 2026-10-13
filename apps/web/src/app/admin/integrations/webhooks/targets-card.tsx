'use client';

import type { WebhookSettingsView } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Field, Textarea } from '@andrewbehma/glass-ui/field';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import {
  describeWebhooksError,
  parseTargets,
} from '../../../../lib/webhooks/format';

/**
 * The private-target allowlist (spec 26 D15): hosts and CIDRs an outbound
 * webhook may reach although they resolve to a private address.
 */
export function TargetsCard() {
  const [saved, setSaved] = useState<string[]>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const settings = await api<WebhookSettingsView>(
        '/admin/settings/webhooks',
      );
      setSaved(settings.allowedPrivateTargets);
      setText(settings.allowedPrivateTargets.join('\n'));
      setLoadError(undefined);
    } catch (err) {
      setLoadError(describeWebhooksError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = parseTargets(text);
  const dirty =
    saved !== undefined &&
    parsed.ok &&
    parsed.targets.join('\n') !== saved.join('\n');

  const save = async () => {
    if (!parsed.ok) return;
    setBusy(true);
    try {
      const settings = await api<WebhookSettingsView>(
        '/admin/settings/webhooks',
        {
          method: 'PUT',
          body: { allowedPrivateTargets: parsed.targets },
        },
      );
      setSaved(settings.allowedPrivateTargets);
      setText(settings.allowedPrivateTargets.join('\n'));
      toast.success('Allowlist saved');
    } catch (err) {
      toast.error(describeWebhooksError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <section
        aria-labelledby="private-targets"
        className="flex flex-col gap-3 p-4"
      >
        <div>
          <h2 id="private-targets" className="text-sm font-semibold">
            Private-target allowlist
          </h2>
          <p className="max-w-prose text-sm text-ink-2">
            Outbound webhooks to loopback, private, link-local or Tailscale
            addresses are refused unless the host or CIDR is listed here. Hosts
            are resolved at send time. A listed host may also use plain http.
          </p>
        </div>
        {loadError && saved === undefined ? (
          <SectionUnavailable
            title="The allowlist is not answering"
            stillWorks="Webhooks keep using the allowlist the server has."
            detail={loadError}
            action={
              <Button variant="glass" size="sm" onClick={load}>
                Try again
              </Button>
            }
          />
        ) : null}
        <Field
          label="Hosts and CIDRs"
          htmlFor="webhook-targets"
          hint="One per line, e.g. n8n.lan or 192.168.1.0/24."
          error={parsed.ok ? undefined : parsed.problem}
        >
          <Textarea
            id="webhook-targets"
            rows={4}
            className="font-mono"
            disabled={saved === undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <div>
          <Button disabled={busy || !dirty} onClick={save}>
            {busy ? 'Saving…' : 'Save allowlist'}
          </Button>
        </div>
      </section>
    </Card>
  );
}
