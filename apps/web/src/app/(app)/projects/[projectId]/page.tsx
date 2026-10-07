import { redirect } from 'next/navigation';

/**
 * A project's home. Settings is the only project page today; the fleet page
 * (#11) changes this one redirect and nothing else.
 */
export default async function ProjectHome({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/settings`);
}
