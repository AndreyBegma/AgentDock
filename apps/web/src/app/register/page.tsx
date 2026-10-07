'use client';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type RegisterRequest,
  type RegisterResponse,
  type RegistrationState,
} from '@agentdock/shared';
import { Button, buttonClassName } from 'glass-ui/button';
import { Field, Input } from 'glass-ui/field';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { AuthCard } from '../../components/auth-card';
import { api, describeError } from '../../lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [open, setOpen] = useState<boolean>();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<RegistrationState>('/auth/registration')
      .then((state) => setOpen(state.open))
      .catch(() => setOpen(false));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body: RegisterRequest = {
        email,
        password,
        ...(name.trim() ? { name: name.trim() } : {}),
      };
      await api<RegisterResponse>('/auth/register', { method: 'POST', body });
      router.replace('/pending');
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  if (open === undefined) return null;

  if (!open) {
    return (
      <AuthCard
        title="Registration is closed"
        description="Ask an administrator to open registration or to create an account for you."
      >
        <Link
          href="/login"
          className={buttonClassName({ variant: 'glass', full: true })}
        >
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create an account"
      description="An administrator has to approve it before you can sign in."
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
          error={error}
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
        <Button type="submit" variant="solid" full disabled={busy}>
          {busy ? 'Registering…' : 'Register'}
        </Button>
      </form>
      <p className="text-sm text-ink-2">
        Already have an account?{' '}
        <Link href="/login" className="text-ink underline">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
