import { redirect } from 'next/navigation';
import { tasksRedirectTarget } from '../../../lib/work/format';

/** D13: the Tasks page is the Work List, filtered to plan tasks. */
export default async function TasksRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(tasksRedirectTarget(await searchParams));
}
