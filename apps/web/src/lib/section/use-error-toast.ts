'use client';

import { toast } from 'glass-ui/toast';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { type Described, errorText, errorToastOptions } from '../api';

/**
 * An error toast that carries its fix: when the hint names a page, the toast
 * gets an action that goes there. Pass what a `describe…Error` helper returned.
 */
export function useErrorToast(): (described: Described) => void {
  const router = useRouter();
  return useCallback(
    (described: Described) => {
      toast.error(
        errorText(described),
        errorToastOptions(described, (href) => router.push(href)),
      );
    },
    [router],
  );
}
