import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/app-shell';
import { requireUser } from '../../components/shell/current-user';

export default async function AccountLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <AppShell user={await requireUser()}>{children}</AppShell>;
}
