'use client';

import { GITHUB_APP_ADMIN_PAGE } from '@agentdock/shared';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiCallbackUrl } from '../../../../../lib/github-app/format';

/**
 * Where GitHub sends the browser after the manifest flow. The code is
 * exchanged by the API, so this page only hands the browser over — a full
 * navigation, because the API answers with a redirect and needs the session
 * cookie.
 */
export default function GitHubCallbackPage() {
  const router = useRouter();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const target = apiCallbackUrl(window.location.search);
    if (target) window.location.replace(target);
    else setMissing(true);
  }, []);

  if (!missing) return <p className="text-ink-2 text-sm">Finishing…</p>;
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Banner tone="warn" title="Nothing to finish">
        GitHub’s redirect carried no registration code. Start the registration
        again from the GitHub App page.
      </Banner>
      <div>
        <Button onClick={() => router.push(GITHUB_APP_ADMIN_PAGE)}>
          Back to the GitHub App page
        </Button>
      </div>
    </div>
  );
}
