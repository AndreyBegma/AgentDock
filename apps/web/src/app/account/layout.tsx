import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/app-shell';
import { requireUser } from '../../components/shell/current-user';

export const metadata: Metadata = { title: 'Account' };

export default async function AccountLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <AppShell user={await requireUser({ allowTwoFactorSetup: true })}>
      {children}
    </AppShell>
  );
}
