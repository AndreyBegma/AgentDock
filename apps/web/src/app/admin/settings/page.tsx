import { redirect } from 'next/navigation';

/** Registration moved to Users, the page it governs. */
export default function AdminSettingsPage() {
  redirect('/admin/users');
}
