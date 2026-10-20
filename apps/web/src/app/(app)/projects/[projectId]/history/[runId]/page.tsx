import { redirect } from 'next/navigation';
import { historyRedirectTarget } from '../../../../../../lib/history/format';

/** C-285: a run opens beside the Runs tab of Activity. */
export default async function RunRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, runId } = await params;
  redirect(historyRedirectTarget(projectId, await searchParams, runId));
}
