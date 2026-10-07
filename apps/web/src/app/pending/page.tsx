import { buttonClassName } from 'glass-ui/button';
import Link from 'next/link';
import { AuthCard } from '../../components/auth-card';

// A pending account holds no session, so there is nothing to sign out of:
// the way out is back to the sign-in page.
export default function PendingPage() {
  return (
    <AuthCard
      title="Waiting for an administrator"
      description="Your account has been created. You can sign in as soon as an administrator approves it."
    >
      <Link
        href="/login"
        className={buttonClassName({ variant: 'glass', full: true })}
      >
        Back to sign in
      </Link>
    </AuthCard>
  );
}
