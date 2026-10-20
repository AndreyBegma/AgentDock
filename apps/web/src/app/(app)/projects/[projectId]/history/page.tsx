import { redirect } from 'next/navigation';
import { historyRedirectTarget } from '../../../../../lib/history/format';

/** C-285: History is the Runs tab of Activity; an old link keeps its filters. */
export default async function HistoryRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  redirect(historyRedirectTarget(projectId, await searchParams));
}
