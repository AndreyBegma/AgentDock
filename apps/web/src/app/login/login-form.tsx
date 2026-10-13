'use client';

import {
  AUTH_ERROR,
  type LoginRequest,
  type PublicUser,
  type RegistrationState,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { AuthCard } from '../../components/auth-card';
import { ApiError, api, describeError } from '../../lib/api';
import { INSTALL_PATH } from '../../lib/runners/install';
import { safeNext } from './safe-next';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);

  useEffect(() => {
    api<RegistrationState>('/auth/registration')
      .then((state) => setRegistrationOpen(state.open))
      .catch(() => setRegistrationOpen(false));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body: LoginRequest = { email, password };
      await api<PublicUser>('/auth/login', { method: 'POST', body });
      // Read at submit time: no `useSearchParams`, so no Suspense boundary.
      router.replace(
        safeNext(new URLSearchParams(window.location.search).get('next')),
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === AUTH_ERROR.pendingApproval) {
        router.replace('/pending');
        return;
      }
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in" description="With your account on this server.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="password" error={error}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="solid" full disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <div className="flex flex-col gap-1 border-t border-line pt-4 text-sm text-ink-2">
        {registrationOpen ? (
          <p>
            No account?{' '}
            <Link href="/register" className="text-ink underline">
              Register
            </Link>
          </p>
        ) : null}
        <p>
          New machine?{' '}
          <Link href={INSTALL_PATH} className="text-ink underline">
            Install the runner
          </Link>
        </p>
      </div>
    </AuthCard>
  );
}
