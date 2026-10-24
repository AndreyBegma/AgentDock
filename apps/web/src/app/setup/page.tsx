import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SetupForm } from './setup-form';
import { needsSetup, setupRedirect, setupToken } from './setup-redirect';

export const metadata: Metadata = { title: 'Set up Nautelle' };

/**
 * C-367: the first-run setup. Open while the instance has no user; once one
 * exists it is the sign-in page's turn.
 */
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const to = setupRedirect(await needsSetup());
  if (to) redirect(to);
  const { token } = await searchParams;
  return <SetupForm token={setupToken(token)} />;
}
