'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { Field, Input, Textarea } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { toast } from '@andrewbehma/glass-ui/toast';
import {
  GITHUB_APP_EVENTS,
  GITHUB_APP_PERMISSIONS,
  type GitHubAppView,
  type GitHubManifestRequest,
  type GitHubManifestResponse,
} from '@nautelle/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { DisabledReason } from '../../../../components/prerequisites/disabled-reason';
import { api } from '../../../../lib/api';
import {
  type CredentialsForm,
  credentialsErrorField,
  credentialsProblem,
  describeGitHubAppError,
  EVENT_LABEL,
  emptyCredentialsForm,
  githubWebhookUrl,
  PERMISSION_LABEL,
  parseOwner,
  toCredentialsRequest,
} from '../../../../lib/github-app/format';
import { PUBLIC_URL_REMEDY } from '../../../../lib/prerequisites/copy';

type Unregistered = Extract<GitHubAppView, { registered: false }>;

/** Rule R1: both register paths are off without a key, and say so up front. */
const NO_KEY_REASON =
  'Registering needs APP_ENCRYPTION_KEY on the server — see the banner above.';

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
      <SectionHeader className="mb-2" title="Register the App" />
      <p className="mb-4 max-w-prose text-sm text-ink-2">
        One read-only GitHub App for this instance. GitHub shows the permissions
        before you confirm; Nautelle never writes to GitHub through it.
      </p>
      {view.publicUrl ? null : (
        <div className="mb-4 max-w-prose">
          <Banner tone="warn" title="No PUBLIC_URL">
            GitHub cannot reach this server, so the App is registered with its
            webhook inactive and runners keep polling every 60 s.{' '}
            {PUBLIC_URL_REMEDY}
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
            disabled={!view.encryptionAvailable}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-1">
          <div>
            <Button
              type="submit"
              variant="solid"
              disabled={busy || !view.encryptionAvailable}
              aria-describedby={
                view.encryptionAvailable ? undefined : 'gh-register-reason'
              }
            >
              {flow ? 'Opening GitHub…' : 'Register on GitHub'}
            </Button>
          </div>
          {view.encryptionAvailable ? null : (
            <DisabledReason id="gh-register-reason">
              {NO_KEY_REASON}
            </DisabledReason>
          )}
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

type FieldErrors = Partial<Record<keyof CredentialsForm, string>>;

/** The fallback: an App created by hand, its credentials pasted here (spec D1). */
export function ManualCard({
  view,
  onSaved,
}: {
  view: Unregistered;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(emptyCredentialsForm);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const webhookUrl = githubWebhookUrl(view.publicUrl);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const problem = credentialsProblem(form);
    if (problem) {
      setErrors({ [problem.field]: problem.text });
      setFormError(undefined);
      return;
    }
    setBusy(true);
    setErrors({});
    setFormError(undefined);
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
      const text = describeGitHubAppError(err);
      const field = credentialsErrorField(err);
      if (field) setErrors({ [field]: text });
      else setFormError(text);
    } finally {
      setBusy(false);
    }
  };

  const set = (key: keyof CredentialsForm) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  return (
    <Card pad="lg">
      <SectionHeader className="mb-2" title="Enter credentials by hand" />
      <p className="mb-4 max-w-prose text-sm text-ink-2">
        For an App you create yourself on GitHub. The private key and the
        webhook secret are stored encrypted and are never shown again.
      </p>

      <ol className="mb-6 flex max-w-prose list-decimal flex-col gap-3 pl-5 text-sm text-ink-2">
        <li>
          On GitHub open{' '}
          <a
            href="https://github.com/settings/apps/new"
            target="_blank"
            rel="noreferrer"
            className="text-accent-ink underline underline-offset-2"
          >
            Settings › Developer settings › GitHub Apps › New GitHub App
          </a>{' '}
          (for an organization: the organization’s Settings › Developer
          settings).
        </li>
        <li className="flex flex-col gap-2">
          {webhookUrl ? (
            <>
              <span>
                Webhook: tick <strong>Active</strong> and set the URL to
              </span>
              <CodeBlock code={webhookUrl} />
            </>
          ) : (
            <span>
              Webhook: untick <strong>Active</strong>. Without PUBLIC_URL GitHub
              cannot reach this server and runners keep polling every 60 s.{' '}
              {PUBLIC_URL_REMEDY}
            </span>
          )}
          <span>
            Webhook secret: a long random string, e.g. from{' '}
            <code className="font-mono">openssl rand -hex 32</code>. Enter the
            same value below.
          </span>
        </li>
        <li>
          Repository permissions, all <strong>Read-only</strong>:{' '}
          {Object.keys(GITHUB_APP_PERMISSIONS)
            .map(
              (key) =>
                PERMISSION_LABEL[key as keyof typeof GITHUB_APP_PERMISSIONS],
            )
            .join(', ')}
          .
        </li>
        <li>
          Subscribe to events:{' '}
          {GITHUB_APP_EVENTS.map((event) => EVENT_LABEL[event]).join(', ')}.
        </li>
        <li>
          Create the App. The <strong>App ID</strong> is at the top of its
          General page; the <strong>slug</strong> is the last part of its public
          link, github.com/apps/&lt;slug&gt;. Under{' '}
          <strong>Private keys</strong> choose Generate a private key — GitHub
          downloads a .pem file.
        </li>
      </ol>

      <form onSubmit={save} className="flex max-w-md flex-col gap-4">
        {formError ? <Banner tone="danger">{formError}</Banner> : null}
        <Field
          label="App ID"
          htmlFor="gh-app-id"
          required
          hint="A number, at the top of the App’s General page."
          error={errors.appId}
        >
          <Input
            id="gh-app-id"
            inputMode="numeric"
            autoComplete="off"
            disabled={!view.encryptionAvailable}
            value={form.appId}
            onChange={(e) => set('appId')(e.target.value)}
          />
        </Field>
        <Field
          label="Slug"
          htmlFor="gh-slug"
          required
          hint="The App’s name in github.com/apps/<slug>."
          error={errors.slug}
        >
          <Input
            id="gh-slug"
            autoComplete="off"
            spellCheck={false}
            disabled={!view.encryptionAvailable}
            value={form.slug}
            onChange={(e) => set('slug')(e.target.value)}
          />
        </Field>
        <Field
          label="Private key (PEM)"
          htmlFor="gh-private-key"
          required
          hint="Paste the whole .pem file, BEGIN and END lines included."
          error={errors.privateKey}
        >
          <Textarea
            id="gh-private-key"
            rows={4}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
            disabled={!view.encryptionAvailable}
            value={form.privateKey}
            onChange={(e) => set('privateKey')(e.target.value)}
          />
        </Field>
        <Field
          label="Webhook secret"
          htmlFor="gh-webhook-secret"
          required
          hint="The same value you entered on GitHub."
          error={errors.webhookSecret}
        >
          <Input
            id="gh-webhook-secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={!view.encryptionAvailable}
            value={form.webhookSecret}
            onChange={(e) => set('webhookSecret')(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-1">
          <div>
            <Button
              type="submit"
              variant="glass"
              disabled={busy || !view.encryptionAvailable}
              aria-describedby={
                view.encryptionAvailable ? undefined : 'gh-manual-reason'
              }
            >
              Save credentials
            </Button>
          </div>
          {view.encryptionAvailable ? null : (
            <DisabledReason id="gh-manual-reason">
              {NO_KEY_REASON}
            </DisabledReason>
          )}
        </div>
      </form>
    </Card>
  );
}
