import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser } from '../../components/shell/current-user';
import { loginRedirect, needsSetup } from '../setup/setup-redirect';
import { LoginForm } from './login-form';
import { signedInRedirect } from './safe-next';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * A server without any account goes to the first-run setup (C-367). A
 * visitor who is already signed in goes on to `?next=` or home (#159). Only
 * a 200 from `/auth/me` counts: a stale cookie keeps the form, since
 * `requireUser` sends a 401 back here and a cookie check would loop.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const setup = loginRedirect(await needsSetup());
  if (setup) redirect(setup);
  const { next } = await searchParams;
  const to = signedInRedirect((await currentUser()) !== null, next);
  if (to) redirect(to);
  return <LoginForm />;
}
