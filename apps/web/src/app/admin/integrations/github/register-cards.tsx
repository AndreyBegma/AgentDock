'use client';

import type {
  GitHubAppView,
  GitHubManifestRequest,
  GitHubManifestResponse,
} from '@agentdock/shared';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { Field, Input, Textarea } from 'glass-ui/field';
import { toast } from 'glass-ui/toast';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../../../../lib/api';
import {
  credentialsProblem,
  describeGitHubAppError,
  emptyCredentialsForm,
  parseOwner,
  toCredentialsRequest,
} from '../../../../lib/github-app/format';

type Unregistered = Extract<GitHubAppView, { registered: false }>;

/** The manifest flow: the browser posts the manifest to GitHub (spec D1). */
export function RegisterCard({ view }: { view: Unregistered }) {
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [flow, setFlow] = useState<GitHubManifestResponse>();
  const formRef = useRef<HTMLFormElement>(null);

  // The form carries the manifest; it leaves for GitHub as soon as it is rendered.
  useEffect(() => {
    if (flow) formRef.current?.submit();
  }, [flow]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseOwner(owner);
    if (parsed === undefined) {
      setError('That is not a valid GitHub organization login.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const body: GitHubManifestRequest = parsed ? { owner: parsed } : {};
      setFlow(
        await api<GitHubManifestResponse>('/admin/github-app/manifest', {
          method: 'POST',
          body,
        }),
      );
    } catch (err) {
      setError(describeGitHubAppError(err));
      setBusy(false);
    }
  };

  return (
    <Card pad="lg">
      <h2 className="mb-2 text-lg font-bold">Register the App</h2>
      <p className="mb-4 max-w-prose text-sm text-ink-2">
        One read-only GitHub App for this instance. GitHub shows the permissions
        before you confirm; AgentDock never writes to GitHub through it.
      </p>
      {view.publicUrl ? null : (
        <div className="mb-4 max-w-prose">
          <Banner tone="warn" title="No PUBLIC_URL">
            GitHub cannot reach this server, so the App is registered with its
            webhook inactive. Polling stays at 60 s. Set <code>PUBLIC_URL</code>{' '}
            on the API to receive deliveries.
          </Banner>
        </div>
      )}
      <form onSubmit={start} className="flex max-w-md flex-col gap-4">
        <Field
          label="Organization (optional)"
          htmlFor="gh-owner"
          hint="Leave empty to create the App under your own GitHub account."
          error={error}
        >
          <Input
            id="gh-owner"
            autoComplete="off"
            spellCheck={false}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" variant="solid" disabled={busy}>
            {flow ? 'Opening GitHub…' : 'Register on GitHub'}
          </Button>
        </div>
      </form>
      {flow ? (
        <form
          ref={formRef}
          method="post"
          action={flow.postUrl}
          className="hidden"
        >
          <input
            type="hidden"
            name="manifest"
            value={JSON.stringify(flow.manifest)}
          />
        </form>
      ) : null}
    </Card>
  );
}

/** The fallback: an App created by hand, its credentials pasted here (spec D1). */
export function ManualCard({ onSaved }: { onSaved: () => void }) {
  const [form, setForm] = useState(emptyCredentialsForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const problem = credentialsProblem(form);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api('/admin/github-app', {
        method: 'PUT',
        body: toCredentialsRequest(form),
      });
      // The secrets are gone from the page the moment they are sent.
      setForm(emptyCredentialsForm());
      toast.success('GitHub App saved.');
      onSaved();
    } catch (err) {
      setError(describeGitHubAppError(err));
    } finally {
      setBusy(false);
    }
  };

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <Card pad="lg">
      <h2 className="mb-2 text-lg font-bold">Enter credentials by hand</h2>
      <p className="mb-4 max-w-prose text-sm text-ink-2">
        For an App you created yourself. The private key and the webhook secret
        are stored encrypted and are never shown again.
      </p>
      <form onSubmit={save} className="flex max-w-md flex-col gap-4">
        <Field label="App ID" htmlFor="gh-app-id">
          <Input
            id="gh-app-id"
            inputMode="numeric"
            autoComplete="off"
            value={form.appId}
            onChange={(e) => set('appId')(e.target.value)}
          />
        </Field>
        <Field
          label="Slug"
          htmlFor="gh-slug"
          hint="The App’s name in github.com/apps/<slug>."
        >
          <Input
            id="gh-slug"
            autoComplete="off"
            spellCheck={false}
            value={form.slug}
            onChange={(e) => set('slug')(e.target.value)}
          />
        </Field>
        <Field label="Private key (PEM)" htmlFor="gh-private-key">
          <Textarea
            id="gh-private-key"
            rows={4}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
            value={form.privateKey}
            onChange={(e) => set('privateKey')(e.target.value)}
          />
        </Field>
        <Field label="Webhook secret" htmlFor="gh-webhook-secret" error={error}>
          <Input
            id="gh-webhook-secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={form.webhookSecret}
            onChange={(e) => set('webhookSecret')(e.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" variant="solid" disabled={busy}>
            Save credentials
          </Button>
        </div>
      </form>
    </Card>
  );
}
