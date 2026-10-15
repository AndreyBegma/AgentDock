import { api } from '../api';

/** `DELETE /projects/:projectId/attachments/:id` — the uploader or an admin (D7). */
export const removeAttachment = (projectId: string, id: string) =>
  api(
    `/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
