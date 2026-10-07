import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/app-shell';
import { requireUser } from '../../components/shell/current-user';

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await requireUser();
  // Presentation only: the API guards every admin endpoint (spec D5).
  if (user.role !== 'admin') redirect('/account');
  return <AppShell user={user}>{children}</AppShell>;
}
