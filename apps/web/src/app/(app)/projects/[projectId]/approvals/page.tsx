import { redirect } from 'next/navigation';
import { approvalsRedirectTarget } from '../../../../../lib/queue/tabs';

/** C-284: Approvals is a tab of the Queue page; old links keep their query. */
export default async function ApprovalsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  redirect(approvalsRedirectTarget(projectId, await searchParams));
}
