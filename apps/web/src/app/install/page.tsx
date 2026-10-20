import type { Metadata } from 'next';
import { InstallGuide } from './install-guide';

export const metadata: Metadata = {
  // The root template adds "· Nautelle".
  title: 'Install the runner',
  description:
    'How to install the Nautelle runner, pair it with this server and keep it online.',
};

/** Public (issue #145): the proxy lets `/install` through without a session. */
export default function InstallPage() {
  return <InstallGuide />;
}
