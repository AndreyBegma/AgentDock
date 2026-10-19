import { buttonClassName } from '@andrewbehma/glass-ui/button';
import Link from 'next/link';

/**
 * Generate design on a stack page sends nothing: it opens the stack design
 * viewer, where `GeneratePanel` offers the variant count and the Design skills
 * before the generate request (#644).
 */
export function GenerateDesignLink({ href }: { href: string }) {
  return (
    <Link href={href} className={buttonClassName({ variant: 'solid' })}>
      Generate design
    </Link>
  );
}
