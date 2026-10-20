'use client';

import { toast } from '@andrewbehma/glass-ui/toast';
import type { AttachmentView } from '@nautelle/shared';
import { useState } from 'react';
import { removeAttachment } from '../../lib/attachments/actions';
import { describeBoardError } from '../../lib/board/format';

/** Remove one saved attachment (uploader or admin, D7); `removing` is the id in flight. */
export function useRemoveAttachment(projectId: string, onChanged: () => void) {
  const [removing, setRemoving] = useState<string>();
  const remove = async (attachment: AttachmentView) => {
    setRemoving(attachment.id);
    try {
      await removeAttachment(projectId, attachment.id);
      onChanged();
    } catch (err) {
      toast.error(describeBoardError(err));
    } finally {
      setRemoving(undefined);
    }
  };
  return { removing, remove };
}
