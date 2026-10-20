import { redirect } from 'next/navigation';

/** The account menu's Admin entry lands on the first admin page (C-282). */
export default function AdminPage() {
  redirect('/admin/runners');
}
