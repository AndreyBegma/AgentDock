import { Skeleton } from '@andrewbehma/glass-ui/skeleton';

/**
 * What a workspace page shows while its server part streams (#213): the shape
 * of a page — the header's title and description, then a block of rows — so
 * nothing jumps when it arrives. The shell stays put around it.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading the page"
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
