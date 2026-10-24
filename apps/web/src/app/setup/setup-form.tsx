'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import {
  AUTH_ERROR,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PublicUser,
  type SetupAdminRequest,
} from '@nautelle/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AuthCard } from '../../components/auth-card';
import { ApiError, api, describeError } from '../../lib/api';
import { HOME_PATH } from '../login/safe-next';
import { LOGIN_PATH } from './setup-redirect';

const LOG_COMMAND = 'docker compose logs api | grep /setup';

export function SetupForm({ token }: { token: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <AuthCard
        title="Open the setup link"
        description="This server has no account yet. The API printed a one-time link to create the first administrator; open that link."
      >
        <CodeBlock code={LOG_COMMAND} language="sh" />
      </AuthCard>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== repeat) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const body: SetupAdminRequest = {
        token,
        email,
        password,
        ...(name.trim() ? { name: name.trim() } : {}),
      };
      await api<PublicUser>('/setup/admin', { method: 'POST', body });
      router.replace(HOME_PATH);
    } catch (err) {
      // Someone finished the setup first: their account is the way in.
      if (err instanceof ApiError && err.code === AUTH_ERROR.setupDone) {
        router.replace(LOGIN_PATH);
        return;
      }
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Set up Nautelle"
      description="Create the first administrator of this server. You are signed in as them right after."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email" htmlFor="email" required>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Name" htmlFor="name">
          <Input
            id="name"
            autoComplete="name"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          required
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Repeat password" htmlFor="repeat" required error={error}>
          <Input
            id="repeat"
            type="password"
            autoComplete="new-password"
            required
            maxLength={PASSWORD_MAX_LENGTH}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="solid" full disabled={busy}>
          {busy ? 'Creating…' : 'Create administrator'}
        </Button>
      </form>
    </AuthCard>
  );
}
