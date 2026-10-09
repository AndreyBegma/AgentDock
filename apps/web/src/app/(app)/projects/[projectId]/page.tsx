import { redirect } from 'next/navigation';

/**
 * A project's home is its fleet (spec 11). This redirect is the one place the
 * landing page is chosen; Settings stays in the project navigation.
 */
export default async function ProjectHome({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/fleet`);
}
