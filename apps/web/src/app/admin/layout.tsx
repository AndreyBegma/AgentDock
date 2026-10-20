import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AdminNav } from '../../components/shell/admin-nav';
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
  // C-282: the admin pages are not in the rail; this row links them.
  return (
    <AppShell user={user}>
      <div className="flex flex-col gap-4">
        <AdminNav />
        {children}
      </div>
    </AppShell>
  );
}
